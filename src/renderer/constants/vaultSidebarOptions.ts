import type { VaultGroupField, VaultSortDirection, VaultSortField } from '../../shared/types';

/**
 * Sort By / Group By choices of the vault sidebar. The sidebar's own menus
 * and the Vault Sidebar section of General settings both list these, since
 * they change the same setting.
 */

// "None" sorts by the saved manual order: drag-and-drop in the sidebar
// works only while it is chosen.
export const SORT_FIELDS: { value: VaultSortField; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'name', label: 'Name' },
  { value: 'modified', label: 'Date Modified' },
  { value: 'type', label: 'Type' },
  { value: 'size', label: 'Size' },
];

// "None" turns the secondary sort off.
export const GROUP_FIELDS: { value: VaultGroupField; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'name', label: 'Name' },
  { value: 'modified', label: 'Date Modified' },
  { value: 'type', label: 'Type' },
  { value: 'size', label: 'Size' },
];

export const DIRECTIONS: { value: VaultSortDirection; label: string }[] = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
];
