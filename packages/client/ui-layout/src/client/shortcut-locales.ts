/** Layout command and drawer labels. */
export const zh = { toggle: '展开／收起左侧栏', 'drawer.open': '打开左侧栏' }
/** English labels for the same layout commands. */
export const en: Record<keyof typeof zh, string> = { toggle: 'Toggle left sidebar', 'drawer.open': 'Open left sidebar' }

/** Japanese copy, checked against the English keys. */
export const ja = {
  'toggle': '左サイドバーを切り替え',
  'drawer.open': '左サイドバーを開く',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  toggle: 'Alternar barra lateral izquierda',
  'drawer.open': 'Abrir barra lateral izquierda',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  toggle: 'Basculer la barre latérale gauche',
  'drawer.open': 'Ouvrir la barre latérale gauche',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  toggle: 'Linke Seitenleiste umschalten',
  'drawer.open': 'Linke Seitenleiste öffnen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  toggle: 'Переключить левую боковую панель',
  'drawer.open': 'Открыть левую боковую панель',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  toggle: 'Alternar barra lateral esquerda',
  'drawer.open': 'Abrir barra lateral esquerda',
} satisfies Record<keyof typeof en, string>
