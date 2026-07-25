//! 全文索引へ渡す文書本文の抽出。
//!
//! 形式ごとの差異と展開サイズ制限をこのモジュールへ閉じ込め、Tantivyの索引管理から
//! 分離する。PDFはページ単位、PowerPointはスライド単位で返す。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use lopdf::Document;
use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::error::{EngineError, EngineResult};

use super::index_err;

const MAX_PDF_PAGE_DECOMPRESSED_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OFFICE_XML_BYTES: u64 = 64 * 1024 * 1024;

pub(super) struct ExtractedDocument {
	pub(super) pages: Vec<ExtractedPage>,
	pub(super) page_count: Option<u32>,
}

pub(super) struct ExtractedPage {
	pub(super) page: Option<u32>,
	pub(super) text: String,
}

pub(super) fn extract_document(path: &Path) -> EngineResult<ExtractedDocument> {
	if !path.is_file() {
		return Err(EngineError::InvalidPath {
			path: path.display().to_string(),
			reason: "読み取り可能なファイルではありません".to_string(),
		});
	}
	let extension = path
		.extension()
		.and_then(|extension| extension.to_str())
		.map(str::to_ascii_lowercase)
		.ok_or_else(|| EngineError::InvalidInput {
			field: "path".to_string(),
			reason: "対応する拡張子がありません".to_string(),
		})?;

	match extension.as_str() {
		"pdf" => extract_pdf(path),
		"docx" | "pptx" | "xlsx" => extract_office_open_xml(path, &extension),
		"txt" | "md" | "csv" | "json" | "html" | "htm" => extract_plain_text(path),
		_ => Err(EngineError::InvalidInput {
			field: "path".to_string(),
			reason: format!("未対応の文書形式です: .{extension}"),
		}),
	}
}

fn extract_pdf(path: &Path) -> EngineResult<ExtractedDocument> {
	let document = Document::load(path).map_err(index_err)?;
	let page_numbers: Vec<u32> = document.get_pages().keys().copied().collect();
	let mut pages = Vec::with_capacity(page_numbers.len());
	for page_number in &page_numbers {
		let text = document
			.extract_text_with_limit(&[*page_number], MAX_PDF_PAGE_DECOMPRESSED_BYTES)
			.map_err(index_err)?;
		pages.push(ExtractedPage {
			page: Some(*page_number),
			text,
		});
	}
	let page_count = u32::try_from(page_numbers.len()).map_err(|_| EngineError::Index {
		message: "PDFのページ数が上限を超えています".to_string(),
	})?;
	Ok(ExtractedDocument {
		pages,
		page_count: Some(page_count),
	})
}

fn extract_office_open_xml(path: &Path, extension: &str) -> EngineResult<ExtractedDocument> {
	let file = File::open(path)?;
	let mut archive = ZipArchive::new(file).map_err(index_err)?;
	let mut selected = Vec::new();
	for index in 0..archive.len() {
		let entry = archive.by_index(index).map_err(index_err)?;
		let name = entry.name().replace('\\', "/");
		let include = match extension {
			"docx" => name == "word/document.xml",
			"pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
			"xlsx" => {
				name == "xl/sharedStrings.xml"
					|| (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
			}
			_ => false,
		};
		if include {
			selected.push((name, entry.size()));
		}
	}
	selected.sort_by_key(|entry| natural_xml_order(&entry.0));

	let mut total_size = 0u64;
	let mut pages = Vec::with_capacity(selected.len());
	for (position, (name, size)) in selected.into_iter().enumerate() {
		total_size = total_size
			.checked_add(size)
			.ok_or_else(|| EngineError::Index {
				message: "Office文書の展開サイズが上限を超えています".to_string(),
			})?;
		if total_size > MAX_OFFICE_XML_BYTES {
			return Err(EngineError::InvalidInput {
				field: "path".to_string(),
				reason: "Office文書の展開サイズが上限を超えています".to_string(),
			});
		}
		let mut entry = archive.by_name(&name).map_err(index_err)?;
		let mut xml = String::new();
		entry.read_to_string(&mut xml)?;
		let page = if extension == "pptx" {
			u32::try_from(position + 1).ok()
		} else {
			None
		};
		pages.push(ExtractedPage {
			page,
			text: visible_xml_text(&xml)?,
		});
	}
	if pages.is_empty() {
		return Err(EngineError::InvalidInput {
			field: "path".to_string(),
			reason: "Office文書から本文を読み取れません".to_string(),
		});
	}
	let page_count = if extension == "pptx" {
		u32::try_from(pages.len()).ok()
	} else {
		None
	};
	Ok(ExtractedDocument { pages, page_count })
}

fn extract_plain_text(path: &Path) -> EngineResult<ExtractedDocument> {
	let metadata = path.metadata()?;
	if metadata.len() > MAX_TEXT_DOCUMENT_BYTES {
		return Err(EngineError::InvalidInput {
			field: "path".to_string(),
			reason: "テキスト文書のサイズが上限を超えています".to_string(),
		});
	}
	let bytes = std::fs::read(path)?;
	let text = String::from_utf8(bytes).map_err(|_| EngineError::InvalidInput {
		field: "path".to_string(),
		reason: "UTF-8のテキスト文書ではありません".to_string(),
	})?;
	Ok(ExtractedDocument {
		pages: vec![ExtractedPage { page: None, text }],
		page_count: None,
	})
}

fn visible_xml_text(xml: &str) -> EngineResult<String> {
	let mut reader = Reader::from_str(xml);
	reader.config_mut().trim_text(true);
	let mut text = String::new();
	loop {
		match reader.read_event() {
			Ok(Event::Text(value)) => {
				let decoded = value.decode().map_err(index_err)?;
				let unescaped = quick_xml::escape::unescape(&decoded).map_err(index_err)?;
				if !text.is_empty() {
					text.push(' ');
				}
				text.push_str(&unescaped);
			}
			Ok(Event::Eof) => break,
			Ok(_) => {}
			Err(error) => return Err(index_err(error)),
		}
	}
	Ok(text)
}

fn natural_xml_order(name: &str) -> (String, u32) {
	let number = name
		.rsplit_once('/')
		.map_or(name, |(_, file_name)| file_name)
		.chars()
		.filter(char::is_ascii_digit)
		.collect::<String>()
		.parse()
		.unwrap_or(0);
	(
		name.chars()
			.filter(|character| !character.is_ascii_digit())
			.collect(),
		number,
	)
}
