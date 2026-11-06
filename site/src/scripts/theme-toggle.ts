export {};

const root = document.documentElement;
const storageKey = 'recall-theme';

function aria(pref: string) {
  const follows = pref === 'auto' ? ' (follows system)' : '';
  return `Colour theme: ${pref}${follows}. Click to change.`;
}

function apply(pref: 'auto' | 'light' | 'dark') {
  try {
    if (pref === 'auto') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, pref);
  } catch {
    /* storage can be blocked; the attribute still updates this view */
  }
  const theme =
    pref === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  root.dataset.pref = pref;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((button) => {
    button.setAttribute('aria-label', aria(pref));
  });
}

function current(): 'auto' | 'light' | 'dark' {
  const pref = root.dataset.pref;
  return pref === 'light' || pref === 'dark' ? pref : 'auto';
}

if (!root.dataset.themeBound) {
  root.dataset.themeBound = '1';
  apply(current());
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const pref = current();
      apply(pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto');
    });
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (current() === 'auto') apply('auto');
  });
}
