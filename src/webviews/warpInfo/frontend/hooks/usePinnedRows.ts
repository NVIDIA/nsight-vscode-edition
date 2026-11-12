/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useLayoutEffect, type RefObject } from 'react';
import type { Warp } from '../../model';

/** Pin each expanded warp's context without detaching its horizontally scrolling headers. */
export function usePinnedRows(
    tableRef: RefObject<HTMLTableElement | null>,
    warps: readonly Warp[],
    expanded: ReadonlyMap<string, unknown>
): void {
    useLayoutEffect(() => {
        const table = tableRef.current;
        if (!table) return;
        const container = table.parentElement!;
        const groups = [...table.tBodies].flatMap((group) => {
            const lanes = group.querySelector<HTMLTableElement>('.lane-table');
            return lanes ? [{ group, row: group.rows[0], lanes, header: lanes.tHead! }] : [];
        });

        function measure(): void {
            const overviewHeight = table!.tHead!.getBoundingClientRect().height;
            // Convert viewport bounds to scroll offsets below the overview header.
            const origin =
                container.getBoundingClientRect().top + overviewHeight - container.scrollTop;
            // Measure layout once; the browser keeps the rows fixed during scrolling.
            const ranges = groups.flatMap(({ group, row, lanes, header }) => {
                const start = group.getBoundingClientRect().top;
                const bounds = lanes.getBoundingClientRect();
                const rowHeight = row.getBoundingClientRect().height;
                const headerHeight = header.getBoundingClientRect().height;
                // Both ranges end together, leaving room for the parent row and lane header.
                return [
                    {
                        element: row,
                        start: start - origin,
                        distance: bounds.bottom - start - rowHeight - headerHeight
                    },
                    {
                        element: header,
                        start: bounds.top - origin - rowHeight,
                        distance: bounds.height - headerHeight
                    }
                ];
            });
            for (const { element, start, distance } of ranges) {
                element.style.setProperty('--pin-start', `${start}px`);
                element.style.setProperty('--pin-end', `${start + distance}px`);
                element.style.setProperty('--pin-distance', `${distance}px`);
            }
            container.style.scrollPaddingTop = `${overviewHeight + Math.max(0, ...groups.map(({ row, header }) => row.getBoundingClientRect().height + header.getBoundingClientRect().height))}px`;
        }

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(table);
        observer.observe(container);
        return () => {
            observer.disconnect();
            container.style.scrollPaddingTop = '';
            for (const { row, header } of groups) {
                for (const element of [row, header]) {
                    element.style.removeProperty('--pin-start');
                    element.style.removeProperty('--pin-end');
                    element.style.removeProperty('--pin-distance');
                }
            }
        };
    }, [tableRef, warps, expanded]);
}
