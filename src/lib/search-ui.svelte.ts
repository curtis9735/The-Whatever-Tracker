/** Shared open/closed state for the universal search overlay. */
export const searchUi = $state({ open: false });

export function openSearch() {
	searchUi.open = true;
}
