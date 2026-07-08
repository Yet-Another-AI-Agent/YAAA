export interface IFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dirPath: string): Promise<string[]>;
  searchFiles(pattern: string, dirPath: string): Promise<string[]>;
}
