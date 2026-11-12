/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import {
    defaultRangeExtractor,
    useVirtualizer,
    type Range,
    type ReactVirtualizer,
    type VirtualItem
} from '@tanstack/react-virtual';
import type { Warp } from '../../model';

type WarpJump = { warp: Warp; lane?: number | null; emphasize?: boolean };

/** Virtualize a warp and its expanded subtable as one measured row group. */
export function useVirtualWarps(
    table: RefObject<HTMLTableElement | null>,
    warps: readonly Warp[],
    expanded: ReadonlyMap<string, unknown>,
    device: number | undefined,
    focusedRow: string | undefined
): {
    virtualizer: ReactVirtualizer<HTMLDivElement, HTMLTableSectionElement>;
    items: VirtualItem[];
    headerHeight: number;
    requestWarpJump: (target: WarpJump) => void;
} {
    const [headerHeight, setHeaderHeight] = useState(28);
    const [jumpTarget, setJumpTarget] = useState<WarpJump>();
    const focusedIndex = warps.findIndex((warp) => `${warp.sm}:${warp.warp}` === focusedRow);
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableSectionElement>({
        count: warps.length,
        getScrollElement: () => (table.current?.parentElement as HTMLDivElement | null) ?? null,
        // Expansion changes height; its key must not reuse a cached collapsed measurement.
        getItemKey: useCallback(
            (index: number) => {
                const warp = warps[index];
                const id = `${warp.sm}:${warp.warp}`;
                return `${device}:${id}:${expanded.has(id)}`;
            },
            [warps, expanded, device]
        ),
        estimateSize: (index) => {
            const warp = warps[index];
            return (
                30 +
                (expanded.has(`${warp.sm}:${warp.warp}`) ? 42 + 26 * (warp.lanes?.length ?? 1) : 0)
            );
        },
        overscan: 6,
        scrollMargin: headerHeight,
        scrollPaddingStart: headerHeight,
        rangeExtractor: useCallback(
            (range: Range) => {
                const indexes = new Set(defaultRangeExtractor(range));
                // Keep keyboard focus mounted, plus its neighbours for ordinary Tab navigation.
                if (focusedIndex >= 0)
                    for (
                        let i = Math.max(0, focusedIndex - 1);
                        i <= Math.min(warps.length - 1, focusedIndex + 1);
                        i++
                    )
                        indexes.add(i);
                return [...indexes].sort((a, b) => a - b);
            },
            [focusedIndex, warps.length]
        )
    });

    useLayoutEffect(() => {
        const header = table.current?.tHead;
        if (!header) return;
        const measure = (): void => setHeaderHeight(header.getBoundingClientRect().height);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(header);
        return () => observer.disconnect();
    }, [table, warps]);

    const items = virtualizer.getVirtualItems();
    useLayoutEffect(() => {
        if (!jumpTarget) return;
        const index = warps.indexOf(jumpTarget.warp);
        const scroll = virtualizer.scrollElement;
        if (index < 0 || !scroll) {
            setJumpTarget(undefined);
            return;
        }
        const group = table.current?.querySelector<HTMLTableSectionElement>(
            `tbody[data-index="${index}"]`
        );
        if (!group) {
            virtualizer.scrollToIndex(index, { align: 'start' });
            return;
        }
        const laneRow =
            jumpTarget.lane == null
                ? null
                : group.querySelector<HTMLTableRowElement>(
                      `.lane-table tr[data-lane-row="${jumpTarget.lane}"]`
                  );
        const row = laneRow ?? group.rows[0];
        // The group gives the overview's original position even while its row is pinned.
        const top =
            (laneRow ?? group).getBoundingClientRect().top - scroll.getBoundingClientRect().top;
        const pinnedHeight =
            headerHeight +
            (laneRow
                ? group.rows[0].getBoundingClientRect().height +
                  group.querySelector('.lane-table thead')!.getBoundingClientRect().height
                : 0);
        const rowHeight = row.getBoundingClientRect().height;
        virtualizer.scrollToOffset(
            scroll.scrollTop + top - (scroll.clientHeight + pinnedHeight - rowHeight) / 2
        );
        if (
            jumpTarget.emphasize &&
            !globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
            // Restart our feedback without cancelling the row's scroll-driven pinning animation.
            for (const animation of row.getAnimations())
                if (animation.id === 'warp-jump') animation.cancel();
            row.animate(
                [
                    { boxShadow: 'inset 0 0 0 9999px var(--row-focus)' },
                    { boxShadow: 'inset 0 0 0 9999px transparent' }
                ],
                { id: 'warp-jump', duration: 1000, easing: 'ease-out' }
            );
        }
        setJumpTarget(undefined);
    }, [jumpTarget, warps, items, table, virtualizer, headerHeight]);

    return { virtualizer, items, headerHeight, requestWarpJump: setJumpTarget };
}
