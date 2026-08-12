export function publishedRecordTable(table: string): string {
  return table === 'messages' ? 'published_messages' : table;
}
