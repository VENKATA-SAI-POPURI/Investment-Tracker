/** The seven groups the redesigned app shows (backend `domain.GROUPS`): one colour and one icon each. */
export type GroupKey = 'equity_india' | 'equity_global' | 'mutual_funds' | 'p2p' | 'commodities' | 'epf' | 'others';

export interface GroupMeta { key: GroupKey; label: string; short: string; icon: string; color: string; }

export const GROUPS: GroupMeta[] = [
  { key: 'equity_india', label: 'India stocks', short: 'India', icon: 'trendUp', color: 'var(--g-equity_india)' },
  { key: 'equity_global', label: 'Global stocks', short: 'Global', icon: 'globe', color: 'var(--g-equity_global)' },
  { key: 'mutual_funds', label: 'Mutual funds', short: 'Funds', icon: 'pieChart', color: 'var(--g-mutual_funds)' },
  { key: 'p2p', label: 'P2P', short: 'P2P', icon: 'handshake', color: 'var(--g-p2p)' },
  { key: 'commodities', label: 'Commodities', short: 'Gold', icon: 'gem', color: 'var(--g-commodities)' },
  { key: 'epf', label: 'EPF', short: 'EPF', icon: 'piggy', color: 'var(--g-epf)' },
  { key: 'others', label: 'Others', short: 'Others', icon: 'layers', color: 'var(--g-others)' },
];

export const GROUP: Record<GroupKey, GroupMeta> = Object.fromEntries(GROUPS.map(g => [g.key, g])) as Record<GroupKey, GroupMeta>;

/** Hex values of the group colours, for SVG charts that cannot read CSS variables in every browser. */
export const GROUP_HEX: Record<GroupKey, string> = {
  equity_india: '#7ea6e8', equity_global: '#a99be6', mutual_funds: '#6fc2ad', p2p: '#d996ad',
  commodities: '#d9b56f', epf: '#e2a07c', others: '#93a1b8',
};

export function groupMeta(key: string | null | undefined): GroupMeta {
  return GROUP[key as GroupKey] ?? GROUP.others;
}

/** "Good morning" / "Good afternoon" / "Good evening" for the Home greeting. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
