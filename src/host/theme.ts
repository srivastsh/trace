const PROPERTIES = {
  '--trace-fg': ['--text-primary', '--color-text-primary'],
  '--trace-muted': ['--text-secondary', '--color-text-secondary'],
  '--trace-border': ['--border-light', '--color-border-light'],
  '--trace-hover': ['--surface-hover', '--menu-hover', '--interactive-bg-secondary-hover'],
};

function color(value: string): string | undefined {
  const token = value.trim();
  if (token.length <= 120 && /^(?:#[a-f0-9]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|color)\([\w\s.,%+\-/]+\))$/i.test(token)
    && CSS.supports('color', token) && token !== 'rgba(0, 0, 0, 0)') return token;
}

function px(value: string, min: number, max: number) {
  const number = Number.parseFloat(value);
  return value.endsWith('px') && Number.isFinite(number) && number >= min && number <= max ? value : undefined;
}

function darkTheme(style: CSSStyleDeclaration): boolean {
  const root = document.documentElement;
  const declared = root.getAttribute('data-theme') || document.body?.getAttribute('data-theme')
    || root.getAttribute('data-color-mode');
  if (declared === 'dark' || declared === 'light') return declared === 'dark';
  if (style.colorScheme === 'dark' || style.colorScheme === 'light') return style.colorScheme === 'dark';
  // ChatGPT's root theme class is a secondary signal along with the declared scheme.
  if (root.classList.contains('dark') && !root.classList.contains('light')) return true;
  if (root.classList.contains('light') && !root.classList.contains('dark')) return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  return darkTheme(getComputedStyle(document.documentElement)) ? 'dark' as const : 'light' as const;
}

export function applyTheme(target: HTMLElement, nearby: HTMLElement, menu?: HTMLElement) {
  const root = getComputedStyle(document.documentElement);
  const nearbyStyle = getComputedStyle(nearby);
  target.dataset.traceTheme = darkTheme(root) ? 'dark' : 'light';
  const allowFont = /^[\w\s"',-]+$/.test(nearbyStyle.fontFamily) && nearbyStyle.fontFamily.length < 256;
  const sampled: Record<string, string | undefined> = {
    '--trace-font': allowFont ? nearbyStyle.fontFamily : undefined,
    '--trace-font-size': px(nearbyStyle.fontSize, 12, 18),
    '--trace-line': px(nearbyStyle.lineHeight, 16, 30),
    '--trace-surface': menu ? color(getComputedStyle(menu).backgroundColor) : undefined,
  };
  for (const [name, aliases] of Object.entries(PROPERTIES)) {
    sampled[name] = aliases.map((alias) => color(root.getPropertyValue(alias))).find(Boolean);
  }
  sampled['--trace-fg'] = color(nearbyStyle.color) ?? sampled['--trace-fg'];
  for (const [name, value] of Object.entries(sampled)) {
    if (value) target.style.setProperty(name, value);
    else target.style.removeProperty(name);
  }
}

export function applyRowGeometry(target: HTMLElement, native: HTMLElement | undefined) {
  if (!native) return;
  const style = getComputedStyle(native);
  const sampled: Record<string, string | undefined> = {
    '--trace-row-height': px(`${native.getBoundingClientRect().height}px`, 30, 56),
    '--trace-row-radius': px(style.borderTopLeftRadius, 4, 20),
    '--trace-row-pad-start': px(style.paddingInlineStart, 4, 24),
    '--trace-row-pad-end': px(style.paddingInlineEnd, 4, 24),
    '--trace-row-gap': px(style.columnGap, 4, 20),
  };
  for (const [name, value] of Object.entries(sampled)) {
    if (value) target.style.setProperty(name, value);
    else target.style.removeProperty(name);
  }
}
