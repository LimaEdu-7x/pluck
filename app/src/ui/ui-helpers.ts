// Pluck UI DOM Helpers - Construção 100% segura sem innerHTML (imune a DOM-XSS)

export function createBaixandoRow(
  name: string,
  statusText: string,
  dotClass?: string,
  statusClass?: string
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'baixando-row';

  const left = document.createElement('div');
  left.className = 'baixando-row-left';

  const dot = document.createElement('span');
  dot.className = dotClass ? `status-dot ${dotClass}` : 'status-dot';

  const nameEl = document.createElement('span');
  nameEl.className = 'baixando-row-name';
  nameEl.textContent = name;

  left.appendChild(dot);
  left.appendChild(nameEl);

  const statusEl = document.createElement('span');
  statusEl.className = statusClass ? `baixando-row-status ${statusClass}` : 'baixando-row-status';
  statusEl.textContent = statusText;

  row.appendChild(left);
  row.appendChild(statusEl);

  return row;
}

export function createConfigItem(title: string, desc: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'config-item';

  const t = document.createElement('div');
  t.className = 'config-title';
  t.textContent = title;

  const d = document.createElement('div');
  d.className = 'config-desc';
  d.textContent = desc;

  item.appendChild(t);
  item.appendChild(d);
  return item;
}

export function createModeCard(
  mod: { id: string; title: string; badge: string; description: string },
  isSelected: boolean,
  onSelect: () => void
): HTMLElement {
  const card = document.createElement('div');
  card.className = `mode-card ${isSelected ? 'active' : ''}`;
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', isSelected ? 'true' : 'false');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${mod.title} - ${mod.badge}`);

  card.onclick = () => onSelect();
  card.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  const header = document.createElement('div');
  header.className = 'mode-card-header';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'mode-card-title';

  const dot = document.createElement('span');
  dot.className = 'mode-dot';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = mod.title;

  titleDiv.appendChild(dot);
  titleDiv.appendChild(titleSpan);

  const badgeSpan = document.createElement('span');
  badgeSpan.className = 'badge';
  badgeSpan.textContent = mod.badge;

  header.appendChild(titleDiv);
  header.appendChild(badgeSpan);

  const descDiv = document.createElement('div');
  descDiv.className = 'mode-card-desc';
  descDiv.textContent = mod.description;

  card.appendChild(header);
  card.appendChild(descDiv);

  return card;
}

export function createMetricRow(label: string, val: string, valClass?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'metrics-row';

  const lbl = document.createElement('span');
  lbl.className = 'metrics-lbl';
  lbl.textContent = label;

  const v = document.createElement('span');
  v.className = valClass ? `metrics-val ${valClass}` : 'metrics-val';
  v.textContent = val;

  row.appendChild(lbl);
  row.appendChild(v);
  return row;
}


const MESES_FICHA = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

/** Data da ficha no estilo datilografado: "27 NOV 2026 · 14:32" (hora local). */
export function formatFichaStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MESES_FICHA[d.getMonth()]} ${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}
