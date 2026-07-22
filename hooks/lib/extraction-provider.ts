export interface ExtractionProvider {
  id: string;
  extract(messages: string): Promise<string | null> | string | null;
}
