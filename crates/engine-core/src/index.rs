//! IndexEngine — Tantivyを用いた全文索引の構築・検索。
//!
//! PDFはページ単位、Office Open XML文書とテキスト文書は文書単位で索引化する。
//! 実ファイルの移動・削除は行わず、索引とSQLiteの補助メタ情報だけを更新する。

use std::path::{Path, PathBuf};

use crate::database::Database;
use crate::error::{EngineError, EngineResult};
use crate::types::SearchHit;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{
	Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
	INDEXED, STORED,
};
use tantivy::snippet::SnippetGenerator;
use tantivy::tokenizer::{LowerCaser, NgramTokenizer, TextAnalyzer};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, Term};

mod extraction;

use extraction::{extract_document, ExtractedPage};

const INDEX_PATH_ENV: &str = "FUZZY_INDEX_PATH";
const TOKENIZER_NAME: &str = "fuzzy_ngram";
const INDEX_WRITER_MEMORY_BYTES: usize = 20_000_000;

/// 全文索引の構築・更新・検索を担うトレイト。
pub trait IndexEngine {
	/// 指定ファイルの本文を抽出して索引に追加（既存なら更新）する。
	fn index_file(&mut self, database: &Database, file_id: i64, path: &Path) -> EngineResult<()>;

	/// 指定ファイルを索引から削除する（DB上の登録解除に追従するのみ。実ファイルは触らない）。
	fn remove_file(&mut self, database: &Database, file_id: i64) -> EngineResult<()>;

	/// インポート後などに索引全体を破棄する。実ファイルとSQLite正本は触らない。
	fn clear(&mut self) -> EngineResult<()>;

	/// クエリ文字列で全文検索し、スコア順のヒットを返す。
	fn search(&self, query: &str, limit: usize) -> EngineResult<Vec<SearchHit>>;
}

/// Tantivyの永続索引を使う既定実装。
pub struct DefaultIndexEngine {
	index: Index,
	reader: IndexReader,
	file_id_field: Field,
	page_field: Field,
	body_field: Field,
}

impl std::fmt::Debug for DefaultIndexEngine {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("DefaultIndexEngine")
			.field("schema", &self.index.schema())
			.finish_non_exhaustive()
	}
}

impl DefaultIndexEngine {
	/// 既定のアプリデータディレクトリにある索引を開く。
	pub fn open_default() -> EngineResult<Self> {
		Self::open(&resolve_index_path()?)
	}

	/// 指定ディレクトリの索引を開き、存在しなければ作成する。
	pub fn open(path: &Path) -> EngineResult<Self> {
		std::fs::create_dir_all(path)?;
		let (schema, file_id_field, page_field, body_field) = index_schema();
		let directory = MmapDirectory::open(path).map_err(index_err)?;
		let index = Index::open_or_create(directory, schema).map_err(index_err)?;
		register_tokenizer(&index)?;
		let reader = index
			.reader_builder()
			.reload_policy(ReloadPolicy::Manual)
			.try_into()
			.map_err(index_err)?;

		Ok(Self {
			index,
			reader,
			file_id_field,
			page_field,
			body_field,
		})
	}

	fn commit_pages(&mut self, file_id: i64, pages: &[ExtractedPage]) -> EngineResult<()> {
		let stored_file_id = u64::try_from(file_id).map_err(|_| EngineError::InvalidInput {
			field: "fileId".to_string(),
			reason: "0以上の整数で指定してください".to_string(),
		})?;
		let mut writer: IndexWriter<TantivyDocument> = self
			.index
			.writer(INDEX_WRITER_MEMORY_BYTES)
			.map_err(index_err)?;
		writer.delete_term(Term::from_field_u64(self.file_id_field, stored_file_id));
		for page in pages.iter().filter(|page| !page.text.trim().is_empty()) {
			let mut document = TantivyDocument::new();
			document.add_u64(self.file_id_field, stored_file_id);
			if let Some(page_number) = page.page {
				document.add_u64(self.page_field, u64::from(page_number));
			}
			document.add_text(self.body_field, &page.text);
			writer.add_document(document).map_err(index_err)?;
		}
		writer.commit().map_err(index_err)?;
		self.reader.reload().map_err(index_err)
	}
}

impl IndexEngine for DefaultIndexEngine {
	fn index_file(&mut self, database: &Database, file_id: i64, path: &Path) -> EngineResult<()> {
		let extracted = extract_document(path)?;
		self.commit_pages(file_id, &extracted.pages)?;
		if let Err(error) = database.mark_search_indexed(file_id, extracted.page_count) {
			// SQLiteを正本とするため、メタ情報を更新できなければ索引だけが残らないよう戻す。
			let _ = self.remove_from_index(file_id);
			return Err(error);
		}
		Ok(())
	}

	fn remove_file(&mut self, database: &Database, file_id: i64) -> EngineResult<()> {
		self.remove_from_index(file_id)?;
		database.remove_search_index_meta(file_id)
	}

	fn clear(&mut self) -> EngineResult<()> {
		let mut writer: IndexWriter<TantivyDocument> = self
			.index
			.writer(INDEX_WRITER_MEMORY_BYTES)
			.map_err(index_err)?;
		writer.delete_all_documents().map_err(index_err)?;
		writer.commit().map_err(index_err)?;
		self.reader.reload().map_err(index_err)
	}

	fn search(&self, query: &str, limit: usize) -> EngineResult<Vec<SearchHit>> {
		let query = query.trim();
		if query.is_empty() {
			return Err(EngineError::InvalidInput {
				field: "query".to_string(),
				reason: "1文字以上の検索語を指定してください".to_string(),
			});
		}
		if limit == 0 {
			return Ok(Vec::new());
		}

		let searcher = self.reader.searcher();
		let parser = QueryParser::for_index(&self.index, vec![self.body_field]);
		let parsed_query = parser.parse_query(query).map_err(index_err)?;
		let top_docs = searcher
			.search(&parsed_query, &TopDocs::with_limit(limit).order_by_score())
			.map_err(index_err)?;
		let mut snippet_generator =
			SnippetGenerator::create(&searcher, parsed_query.as_ref(), self.body_field)
				.map_err(index_err)?;
		snippet_generator.set_max_num_chars(160);

		top_docs
			.into_iter()
			.map(|(score, address)| {
				let document = searcher
					.doc::<TantivyDocument>(address)
					.map_err(index_err)?;
				let file_id = document
					.get_first(self.file_id_field)
					.and_then(|value| value.as_u64())
					.and_then(|value| i64::try_from(value).ok())
					.ok_or_else(|| EngineError::Index {
						message: "索引内のfile_idを読み取れません".to_string(),
					})?;
				let page = document
					.get_first(self.page_field)
					.and_then(|value| value.as_u64())
					.and_then(|value| u32::try_from(value).ok());
				let snippet = snippet_generator.snippet_from_doc(&document);
				Ok(SearchHit {
					file_id,
					snippet: snippet.fragment().trim().to_string(),
					page,
					score,
				})
			})
			.collect()
	}
}

impl DefaultIndexEngine {
	fn remove_from_index(&mut self, file_id: i64) -> EngineResult<()> {
		let stored_file_id = u64::try_from(file_id).map_err(|_| EngineError::InvalidInput {
			field: "fileId".to_string(),
			reason: "0以上の整数で指定してください".to_string(),
		})?;
		let mut writer: IndexWriter<TantivyDocument> = self
			.index
			.writer(INDEX_WRITER_MEMORY_BYTES)
			.map_err(index_err)?;
		writer.delete_term(Term::from_field_u64(self.file_id_field, stored_file_id));
		writer.commit().map_err(index_err)?;
		self.reader.reload().map_err(index_err)
	}
}

fn index_schema() -> (Schema, Field, Field, Field) {
	let mut builder = Schema::builder();
	let file_id = builder.add_u64_field("file_id", INDEXED | STORED);
	let page = builder.add_u64_field("page", STORED);
	let indexing = TextFieldIndexing::default()
		.set_tokenizer(TOKENIZER_NAME)
		.set_index_option(IndexRecordOption::WithFreqsAndPositions);
	let body = builder.add_text_field(
		"body",
		TextOptions::default()
			.set_indexing_options(indexing)
			.set_stored(),
	);
	(builder.build(), file_id, page, body)
}

fn register_tokenizer(index: &Index) -> EngineResult<()> {
	let tokenizer = NgramTokenizer::new(1, 3, false).map_err(index_err)?;
	let analyzer = TextAnalyzer::builder(tokenizer).filter(LowerCaser).build();
	index.tokenizers().register(TOKENIZER_NAME, analyzer);
	Ok(())
}

/// 全文索引の実パスを決定する。
///
/// 1. 環境変数 `FUZZY_INDEX_PATH`
/// 2. SQLiteと同じアプリデータディレクトリ配下の`search-index`
pub fn resolve_index_path() -> EngineResult<PathBuf> {
	if let Some(path) = std::env::var_os(INDEX_PATH_ENV) {
		return Ok(PathBuf::from(path));
	}
	let database_path = crate::resolve_db_path()?;
	let parent = database_path
		.parent()
		.ok_or_else(|| EngineError::Internal {
			message: "索引ディレクトリを決定できません".to_string(),
		})?;
	Ok(parent.join("search-index"))
}

fn index_err(error: impl std::fmt::Display) -> EngineError {
	EngineError::Index {
		message: error.to_string(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use lopdf::content::{Content, Operation};
	use lopdf::{dictionary, Document, Object, Stream};
	use rusqlite::params;
	use std::fs::File;
	use std::io::Write;
	use std::time::{SystemTime, UNIX_EPOCH};
	use zip::write::SimpleFileOptions;

	fn test_directory(name: &str) -> PathBuf {
		std::env::temp_dir().join(format!(
			"fuzzy-index-{name}-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		))
	}

	fn insert_file(database: &Database, file_id: i64, path: &Path) {
		database
			.conn()
			.execute(
				"INSERT INTO files (
					id, original_name, saved_path, size_bytes, hash_blake3
				 ) VALUES (?1, ?2, ?3, 1, ?4)",
				params![
					file_id,
					path.file_name().unwrap().to_string_lossy(),
					path.to_string_lossy(),
					format!("hash-{file_id}")
				],
			)
			.unwrap();
	}

	fn create_two_page_pdf(path: &Path) {
		let mut document = Document::with_version("1.5");
		let pages_id = document.new_object_id();
		let font_id = document.add_object(dictionary! {
			"Type" => "Font",
			"Subtype" => "Type1",
			"BaseFont" => "Courier",
		});
		let resources_id = document.add_object(dictionary! {
			"Font" => dictionary! { "F1" => font_id },
		});
		let mut page_ids = Vec::new();
		for text in ["database basics", "normalization prevents update anomalies"] {
			let content = Content {
				operations: vec![
					Operation::new("BT", vec![]),
					Operation::new("Tf", vec!["F1".into(), 18.into()]),
					Operation::new("Td", vec![72.into(), 700.into()]),
					Operation::new("Tj", vec![Object::string_literal(text)]),
					Operation::new("ET", vec![]),
				],
			};
			let content_id =
				document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
			page_ids.push(document.add_object(dictionary! {
				"Type" => "Page",
				"Parent" => pages_id,
				"Contents" => content_id,
			}));
		}
		document.objects.insert(
			pages_id,
			Object::Dictionary(dictionary! {
				"Type" => "Pages",
				"Kids" => page_ids.into_iter().map(Into::into).collect::<Vec<Object>>(),
				"Count" => 2,
				"Resources" => resources_id,
				"MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
			}),
		);
		let catalog_id = document.add_object(dictionary! {
			"Type" => "Catalog",
			"Pages" => pages_id,
		});
		document.trailer.set("Root", catalog_id);
		document.save(path).unwrap();
	}

	#[test]
	fn indexes_japanese_text_and_updates_metadata() {
		let directory = test_directory("text");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("第4回_正規化.txt");
		std::fs::write(
			&document_path,
			"第3正規化の条件は、推移的関数従属が存在しないことです。",
		)
		.unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 3, &document_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();

		engine.index_file(&database, 3, &document_path).unwrap();
		let hits = engine.search("正規化", 10).unwrap();

		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].file_id, 3);
		assert_eq!(hits[0].page, None);
		assert!(hits[0].snippet.contains("正規化"));
		let page_count: Option<i64> = database
			.conn()
			.query_row(
				"SELECT page_count FROM search_index_meta WHERE file_id = 3",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(page_count, None);
		drop(engine);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn indexes_pdf_by_page_number() {
		let directory = test_directory("pdf");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("第4回_正規化.pdf");
		create_two_page_pdf(&document_path);
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 41, &document_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();

		engine.index_file(&database, 41, &document_path).unwrap();
		let hits = engine.search("normalization", 10).unwrap();

		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].file_id, 41);
		assert_eq!(hits[0].page, Some(2));
		let page_count: i64 = database
			.conn()
			.query_row(
				"SELECT page_count FROM search_index_meta WHERE file_id = 41",
				[],
				|row| row.get(0),
			)
			.unwrap();
		assert_eq!(page_count, 2);
		drop(engine);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn indexes_office_open_xml_document() {
		let directory = test_directory("office");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("正規化_メモ.docx");
		let file = File::create(&document_path).unwrap();
		let mut archive = zip::ZipWriter::new(file);
		archive
			.start_file("word/document.xml", SimpleFileOptions::default())
			.unwrap();
		archive
			.write_all(
				r#"<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>更新異常の防止</w:t></w:r></w:p></w:body></w:document>"#
					.as_bytes(),
			)
			.unwrap();
		archive.finish().unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 4, &document_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();

		engine.index_file(&database, 4, &document_path).unwrap();
		let hits = engine.search("更新異常", 10).unwrap();

		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].file_id, 4);
		assert_eq!(hits[0].page, None);
		drop(engine);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn remove_and_clear_do_not_touch_source_files() {
		let directory = test_directory("remove");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("資料.txt");
		std::fs::write(&document_path, "全文検索の資料").unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 8, &document_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();
		engine.index_file(&database, 8, &document_path).unwrap();

		engine.remove_file(&database, 8).unwrap();
		assert!(engine.search("全文検索", 10).unwrap().is_empty());
		assert!(document_path.exists());

		engine.index_file(&database, 8, &document_path).unwrap();
		engine.clear().unwrap();
		assert!(engine.search("全文検索", 10).unwrap().is_empty());
		assert!(document_path.exists());
		drop(engine);
		std::fs::remove_dir_all(directory).unwrap();
	}
}
