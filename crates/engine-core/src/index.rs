//! IndexEngine — Tantivyを用いた全文索引の構築・検索。
//!
//! PDFはページ単位、Office Open XML文書とテキスト文書は文書単位で索引化する。
//! 実ファイルの移動・削除は行わず、索引とSQLiteの補助メタ情報だけを更新する。

use std::path::{Path, PathBuf};
use std::time::Duration;

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
use unicode_normalization::UnicodeNormalization;

mod extraction;

use extraction::{extract_document, ExtractedDocument, ExtractedPage};

const INDEX_PATH_ENV: &str = "FUZZY_INDEX_PATH";
const TOKENIZER_NAME: &str = "fuzzy_ngram";
const INDEX_WRITER_MEMORY_BYTES: usize = 20_000_000;
const TRANSIENT_INDEX_IO_ATTEMPTS: usize = 8;
const ASSIGNMENT_KEYWORD_PATTERN: &str =
	"課題 レポート 提出 締切 期限 小テスト assignment report deadline due quiz";
const TRANSIENT_INDEX_IO_DELAY: Duration = Duration::from_millis(20);
const MAX_EXTRACTION_WORKERS: usize = 4;

/// 全文索引の構築・更新・検索を担うトレイト。
pub trait IndexEngine {
	/// 指定ファイルの本文を抽出して索引に追加（既存なら更新）する。
	fn index_file(&mut self, database: &Database, file_id: i64, path: &Path) -> EngineResult<()>;

	/// 複数ファイルをまとめて索引へ追加し、入力順の結果を返す。
	///
	/// 独自実装は必要に応じて一括コミットできる。既定では互換性のため単件処理する。
	fn index_files(
		&mut self,
		database: &Database,
		files: &[(i64, PathBuf)],
	) -> Vec<EngineResult<()>> {
		files
			.iter()
			.map(|(file_id, path)| self.index_file(database, *file_id, path))
			.collect()
	}

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
			.reload_policy(ReloadPolicy::OnCommitWithDelay)
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
		self.commit_documents(&[(file_id, pages)])
	}

	fn commit_documents(&mut self, documents: &[(i64, &[ExtractedPage])]) -> EngineResult<()> {
		let documents = documents
			.iter()
			.map(|(file_id, pages)| {
				u64::try_from(*file_id)
					.map(|stored_file_id| (stored_file_id, *pages))
					.map_err(|_| EngineError::InvalidInput {
						field: "fileId".to_string(),
						reason: "0以上の整数で指定してください".to_string(),
					})
			})
			.collect::<EngineResult<Vec<_>>>()?;
		retry_transient_index_io(|| {
			let mut writer: IndexWriter<TantivyDocument> =
				self.index.writer(INDEX_WRITER_MEMORY_BYTES)?;
			writer.garbage_collect_files().wait()?;
			for (stored_file_id, pages) in &documents {
				writer.delete_term(Term::from_field_u64(self.file_id_field, *stored_file_id));
				for page in pages.iter().filter(|page| !page.text.trim().is_empty()) {
					let mut document = TantivyDocument::new();
					document.add_u64(self.file_id_field, *stored_file_id);
					if let Some(page_number) = page.page {
						document.add_u64(self.page_field, u64::from(page_number));
					}
					// 表記ゆれ（全角・半角、空白、句読点）を検索用本文へ正規化する。
					document.add_text(self.body_field, normalize_search_text(&page.text));
					writer.add_document(document)?;
				}
			}
			let commit_result = writer.commit();
			let merge_result = writer.wait_merging_threads();
			commit_result?;
			merge_result?;
			self.reader.reload()
		})
		.map_err(index_err)
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
		if let Err(error) = database.sync_file_content_assignment(
			file_id,
			extracted_document_contains_assignment_keyword(&extracted),
		) {
			let _ = self.remove_from_index(file_id);
			let _ = database.remove_search_index_meta(file_id);
			return Err(error);
		}
		Ok(())
	}

	fn index_files(
		&mut self,
		database: &Database,
		files: &[(i64, PathBuf)],
	) -> Vec<EngineResult<()>> {
		let mut extracted = extract_documents_in_parallel(files);
		let documents = extracted
			.iter()
			.filter_map(|item| {
				item.result
					.as_ref()
					.and_then(|result| result.as_ref().ok())
					.map(|document| (item.file_id, document.pages.as_slice()))
			})
			.collect::<Vec<_>>();
		if !documents.is_empty() {
			if let Err(error) = self.commit_documents(&documents) {
				let message = error.to_string();
				for item in &mut extracted {
					if item.result.as_ref().is_some_and(Result::is_ok) {
						item.result = Some(Err(EngineError::Index {
							message: message.clone(),
						}));
					}
				}
			}
		}

		let mut cleanup_ids = Vec::new();
		for item in &mut extracted {
			let (page_count, contains_assignment_keyword) = match item.result.as_ref() {
				Some(Ok(document)) => (
					document.page_count,
					extracted_document_contains_assignment_keyword(document),
				),
				_ => continue,
			};
			if let Err(error) = database.mark_search_indexed(item.file_id, page_count) {
				cleanup_ids.push(item.file_id);
				item.result = Some(Err(error));
				continue;
			}
			if let Err(error) =
				database.sync_file_content_assignment(item.file_id, contains_assignment_keyword)
			{
				cleanup_ids.push(item.file_id);
				item.result = Some(Err(error));
			}
		}
		if !cleanup_ids.is_empty() {
			let _ = self.remove_many_from_index(&cleanup_ids);
		}

		extracted
			.into_iter()
			.map(|item| {
				item.result
					.expect("並列本文抽出後は必ず結果が設定される")
					.map(|_| ())
			})
			.collect()
	}

	fn remove_file(&mut self, database: &Database, file_id: i64) -> EngineResult<()> {
		self.remove_from_index(file_id)?;
		database.remove_search_index_meta(file_id)
	}

	fn clear(&mut self) -> EngineResult<()> {
		retry_transient_index_io(|| {
			let mut writer: IndexWriter<TantivyDocument> =
				self.index.writer(INDEX_WRITER_MEMORY_BYTES)?;
			writer.garbage_collect_files().wait()?;
			writer.delete_all_documents()?;
			let commit_result = writer.commit();
			let merge_result = writer.wait_merging_threads();
			commit_result?;
			merge_result?;
			self.reader.reload()
		})
		.map_err(index_err)
	}

	fn search(&self, query: &str, limit: usize) -> EngineResult<Vec<SearchHit>> {
		let query = normalize_search_text(query);
		if query.is_empty() {
			return Err(EngineError::InvalidInput {
				field: "query".to_string(),
				reason: "1文字以上の検索語を指定してください".to_string(),
			});
		}
		if limit == 0 {
			return Ok(Vec::new());
		}

		// 別プロセスのコミットと、Windowsで一時的に遅延したreader更新の両方を
		// 検索直前に取り込む。SQLite側の有効行フィルターと合わせ、古いヒットを公開しない。
		retry_transient_index_io(|| self.reader.reload()).map_err(index_err)?;
		let searcher = self.reader.searcher();
		let parser = QueryParser::for_index(&self.index, vec![self.body_field]);
		let parsed_query = parser.parse_query(&query).map_err(index_err)?;
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

fn extracted_document_contains_assignment_keyword(document: &ExtractedDocument) -> bool {
	document.pages.iter().any(|page| {
		let normalized = normalize_search_text(&page.text);
		ASSIGNMENT_KEYWORD_PATTERN
			.split_whitespace()
			.any(|keyword| normalized.contains(keyword))
	})
}

impl DefaultIndexEngine {
	fn remove_from_index(&mut self, file_id: i64) -> EngineResult<()> {
		self.remove_many_from_index(&[file_id])
	}

	fn remove_many_from_index(&mut self, file_ids: &[i64]) -> EngineResult<()> {
		let stored_file_ids = file_ids
			.iter()
			.map(|file_id| {
				u64::try_from(*file_id).map_err(|_| EngineError::InvalidInput {
					field: "fileId".to_string(),
					reason: "0以上の整数で指定してください".to_string(),
				})
			})
			.collect::<EngineResult<Vec<_>>>()?;
		retry_transient_index_io(|| {
			let mut writer: IndexWriter<TantivyDocument> =
				self.index.writer(INDEX_WRITER_MEMORY_BYTES)?;
			writer.garbage_collect_files().wait()?;
			for stored_file_id in &stored_file_ids {
				writer.delete_term(Term::from_field_u64(self.file_id_field, *stored_file_id));
			}
			let commit_result = writer.commit();
			let merge_result = writer.wait_merging_threads();
			commit_result?;
			merge_result?;
			self.reader.reload()
		})
		.map_err(index_err)
	}
}

struct PendingExtraction {
	file_id: i64,
	path: PathBuf,
	result: Option<EngineResult<ExtractedDocument>>,
}

fn extract_documents_in_parallel(files: &[(i64, PathBuf)]) -> Vec<PendingExtraction> {
	let mut pending = files
		.iter()
		.map(|(file_id, path)| PendingExtraction {
			file_id: *file_id,
			path: path.clone(),
			result: None,
		})
		.collect::<Vec<_>>();
	if pending.is_empty() {
		return pending;
	}
	let worker_count = std::thread::available_parallelism()
		.map(usize::from)
		.unwrap_or(1)
		.min(MAX_EXTRACTION_WORKERS)
		.min(pending.len());
	let chunk_size = pending.len().div_ceil(worker_count);
	std::thread::scope(|scope| {
		for chunk in pending.chunks_mut(chunk_size) {
			scope.spawn(move || {
				for item in chunk {
					item.result = Some(extract_document(&item.path));
				}
			});
		}
	});
	pending
}

fn retry_transient_index_io<T>(
	mut operation: impl FnMut() -> tantivy::Result<T>,
) -> tantivy::Result<T> {
	for attempt in 0..TRANSIENT_INDEX_IO_ATTEMPTS {
		match operation() {
			Ok(value) => return Ok(value),
			Err(error)
				if is_transient_index_io(&error) && attempt + 1 < TRANSIENT_INDEX_IO_ATTEMPTS =>
			{
				std::thread::sleep(TRANSIENT_INDEX_IO_DELAY * (attempt as u32 + 1));
			}
			Err(error) => return Err(error),
		}
	}
	unreachable!("索引I/Oの再試行は成功またはエラーで終了する")
}

fn is_transient_index_io(error: &tantivy::TantivyError) -> bool {
	use tantivy::directory::error::{LockError, OpenDirectoryError, OpenReadError, OpenWriteError};

	match error {
		tantivy::TantivyError::IoError(source) => is_permission_denied(source),
		tantivy::TantivyError::OpenWriteError(OpenWriteError::IoError { io_error, .. })
		| tantivy::TantivyError::OpenReadError(OpenReadError::IoError { io_error, .. })
		| tantivy::TantivyError::OpenDirectoryError(OpenDirectoryError::IoError {
			io_error, ..
		})
		| tantivy::TantivyError::OpenDirectoryError(OpenDirectoryError::FailedToCreateTempDir(
			io_error,
		))
		| tantivy::TantivyError::LockFailure(LockError::IoError(io_error), _) => {
			is_permission_denied(io_error)
		}
		tantivy::TantivyError::LockFailure(LockError::LockBusy, _) => true,
		tantivy::TantivyError::OpenWriteError(OpenWriteError::FileAlreadyExists(_)) => true,
		_ => false,
	}
}

fn is_permission_denied(error: &std::io::Error) -> bool {
	error.kind() == std::io::ErrorKind::PermissionDenied
}

fn index_schema() -> (Schema, Field, Field, Field) {
	let mut builder = Schema::builder();
	let file_id = builder.add_u64_field("file_id", INDEXED | STORED);
	let page = builder.add_u64_field("page", STORED);
	let indexing = TextFieldIndexing::default()
		.set_tokenizer(TOKENIZER_NAME)
		.set_index_option(IndexRecordOption::WithFreqsAndPositions);
	let body = builder.add_text_field(
		"body_normalized_v2",
		TextOptions::default()
			.set_indexing_options(indexing)
			.set_stored(),
	);
	(builder.build(), file_id, page, body)
}

/// 全角・半角、大小文字、空白、句読点などを吸収する検索用文字列。
///
/// 文字種そのもの（日本語・英数字）は保持し、検索語と索引本文で同じ値を使う。
pub fn normalize_search_text(value: &str) -> String {
	value
		.nfkc()
		.flat_map(char::to_lowercase)
		.filter(|character| character.is_alphanumeric())
		.collect()
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
	use std::thread;
	use std::time::Duration;
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
	fn search_normalizes_width_whitespace_and_punctuation_variants() {
		let directory = test_directory("search-normalization");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("ＡＩ入門.txt");
		std::fs::write(&document_path, "アラン・チューリング　ＡＩの基礎").unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 71, &document_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();

		engine.index_file(&database, 71, &document_path).unwrap();
		let hits = engine.search("アラン チューリング", 10).unwrap();

		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].file_id, 71);
		assert_eq!(normalize_search_text("ＡＩ・基礎"), "ai基礎");
		drop(engine);
		std::fs::remove_dir_all(directory).unwrap();
	}

	#[test]
	fn indexes_multiple_documents_with_one_batch_api_call() {
		let directory = test_directory("batch");
		std::fs::create_dir_all(&directory).unwrap();
		let first_path = directory.join("正規化.txt");
		let second_path = directory.join("関数従属.txt");
		std::fs::write(&first_path, "正規化は更新異常を防ぎます。").unwrap();
		std::fs::write(&second_path, "関数従属を確認します。").unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 61, &first_path);
		insert_file(&database, 62, &second_path);
		let mut engine = DefaultIndexEngine::open(&directory.join("index")).unwrap();

		let results = engine.index_files(
			&database,
			&[(61, first_path.clone()), (62, second_path.clone())],
		);

		assert_eq!(results.len(), 2);
		assert!(results.into_iter().all(|result| result.is_ok()));
		assert_eq!(engine.search("更新異常", 10).unwrap()[0].file_id, 61);
		assert_eq!(engine.search("関数従属", 10).unwrap()[0].file_id, 62);
		let indexed_count: i64 = database
			.conn()
			.query_row("SELECT count(*) FROM search_index_meta", [], |row| {
				row.get(0)
			})
			.unwrap();
		assert_eq!(indexed_count, 2);
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
	fn observes_commits_from_another_index_engine() {
		let directory = test_directory("cross-process-reload");
		std::fs::create_dir_all(&directory).unwrap();
		let document_path = directory.join("visibility.txt");
		std::fs::write(&document_path, "cross process search visibility").unwrap();
		let database = Database::open_in_memory().unwrap();
		insert_file(&database, 51, &document_path);
		let index_path = directory.join("index");
		let search_engine = DefaultIndexEngine::open(&index_path).unwrap();
		let mut save_engine = DefaultIndexEngine::open(&index_path).unwrap();

		assert!(search_engine.search("visibility", 10).unwrap().is_empty());
		save_engine
			.index_file(&database, 51, &document_path)
			.unwrap();

		let mut hits = Vec::new();
		for _ in 0..100 {
			hits = search_engine.search("visibility", 10).unwrap();
			if !hits.is_empty() {
				break;
			}
			thread::sleep(Duration::from_millis(20));
		}
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].file_id, 51);

		drop(save_engine);
		drop(search_engine);
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

	#[test]
	fn retries_transient_windows_index_io_errors() {
		let mut attempts = 0;
		let result = retry_transient_index_io(|| {
			attempts += 1;
			if attempts == 1 {
				return Err(tantivy::TantivyError::IoError(std::sync::Arc::new(
					std::io::Error::from(std::io::ErrorKind::PermissionDenied),
				)));
			}
			if attempts == 2 {
				return Err(tantivy::TantivyError::OpenWriteError(
					tantivy::directory::error::OpenWriteError::IoError {
						io_error: std::sync::Arc::new(std::io::Error::from(
							std::io::ErrorKind::PermissionDenied,
						)),
						filepath: PathBuf::from("segment.idx"),
					},
				));
			}
			if attempts == 3 {
				return Err(tantivy::TantivyError::OpenWriteError(
					tantivy::directory::error::OpenWriteError::FileAlreadyExists(PathBuf::from(
						"segment.del",
					)),
				));
			}
			Ok("indexed")
		});

		assert_eq!(result.unwrap(), "indexed");
		assert_eq!(attempts, 4);
	}

	#[test]
	fn does_not_retry_permanent_index_io_errors() {
		let mut attempts = 0;
		let result = retry_transient_index_io(|| {
			attempts += 1;
			Err::<(), _>(tantivy::TantivyError::IoError(std::sync::Arc::new(
				std::io::Error::from(std::io::ErrorKind::NotFound),
			)))
		});

		assert!(result.is_err());
		assert_eq!(attempts, 1);
	}
}
