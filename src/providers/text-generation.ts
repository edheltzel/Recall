export interface TextGenerationProvider {
  id: string;
  generate(prompt: string): string | null;
}
