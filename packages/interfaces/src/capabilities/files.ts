export type DownloadFileOptions = {
  timeoutMs?: number;
  maxBytes?: number;
};

export type DownloadFileResult = {
  path: string;
  contentType: string;
  bytes: number;
  sha256: string;
};

export interface IFiles {
  readFile(path: string): Promise<string>;
  readLines(path: string, startLine?: number, endLine?: number): Promise<{ content: string; startLine: number; endLine: number; totalLines: number }>;
  writeFile(path: string, content: string | Buffer): Promise<void>;
  downloadFile(url: string, outputPath: string, options?: DownloadFileOptions): Promise<DownloadFileResult>;
  writeLines(path: string, startLine: number, endLine: number, content: string): Promise<void>;
  delete(path: string, recursive?: boolean): Promise<void>;
  deleteLines(path: string, startLine: number, endLine: number): Promise<void>;
  createDirectory(path: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; createdAt: string; modifiedAt: string }>;
  screenshot(path: string, outputPath: string, startLine?: number, endLine?: number): Promise<unknown>;
  listFiles(dirPath: string): Promise<string[]>;
  searchFiles(pattern: string, dirPath: string): Promise<string[]>;
}
