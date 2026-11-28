export const siteName = 'Recall';

export const siteDescription =
  'Recall captures each session, distills it into one local SQLite file, and injects your identity plus top-ranked records when the next session starts, on hosts that support it.';

export const installCommand =
  'git clone https://github.com/edheltzel/Recall.git && cd Recall && ./packaging/install.sh';

export const repoHref = 'https://github.com/edheltzel/Recall';

export const docsHref = '/docs/';
export const installHref = '/docs/installation/';

export const supportedHosts = ['Claude Code', 'Codex', 'Pi', 'OpenCode', 'omp', 'Grok', 'Cursor', 'JCode', 'Empryo'];

export const ogImage = {
  path: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Recall: Memory for Coding Agents. Capture, distill, recall at session start.',
};
