/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useLayoutEffect, type RefObject } from 'react';
import type { Warp } from '../../model';
import { overviewText } from '../../presentation';
import { WARP_COLUMNS } from '../warpTable';

/** Measure the complete overview, independently of filtering and expanded lane tables. */
export function useColumnSizing(
    tableRef: RefObject<HTMLTableElement | null>,
    warps: readonly Warp[] | undefined
): void {
    useLayoutEffect(() => {
        const table = tableRef.current;
        if (!table || !warps) return;
        const container = table.parentElement!;
        const expandColumn = table.querySelector<HTMLTableColElement>('.column-expand')!;
        const columns = WARP_COLUMNS.map(([key]) => ({
            key,
            element: table.querySelector<HTMLTableColElement>(`.column-${key}`)!,
            header: table.querySelector<HTMLElement>(`th[data-column="${key}"] .column-label`)!,
            width: 0
        }));
        const context = document.createElement('canvas').getContext('2d')!;

        function measure(): void {
            const style = getComputedStyle(table!);
            const padding = 2 * Number.parseFloat(style.getPropertyValue('--cell-padding'));
            const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const monoFont = `${style.fontWeight} ${style.fontSize} ${style.getPropertyValue('--vscode-editor-font-family') || 'monospace'}`;
            const textWidth = (text: string, mono = false): number => {
                context.font = mono ? monoFont : font;
                return context.measureText(text).width;
            };
            // Every sortable header reserves the same 12px indicator and 5px gap.
            for (const column of columns) {
                column.width =
                    column.key === 'lanes'
                        ? Number.parseFloat(getComputedStyle(column.element).width)
                        : Math.ceil(column.header.getBoundingClientRect().width + padding + 17);
                if (column.key === 'warp') column.width += 15;
            }
            const kernel = columns.find((column) => column.key === 'kernel')!;
            let kernelMinimum = kernel.width;
            for (const warp of warps!) {
                const text = overviewText(warp);
                for (const column of columns) {
                    if (column.key === 'lanes') continue;
                    // Warp reserves 15px for the confirmed-focus marker.
                    const controls = column.key === 'warp' ? 15 : 0;
                    column.width = Math.max(
                        column.width,
                        Math.ceil(
                            textWidth(text[column.key], column.key !== 'kernel') +
                                padding +
                                controls
                        )
                    );
                }
                // Leave room for a recognizable name prefix and the complete Grid ID.
                const name = warp.kernelName ?? 'N/A';
                const grid =
                    warp.kernelName === null && warp.gridId === null
                        ? ''
                        : ` (grid ${warp.gridId ?? 'N/A'})`;
                kernelMinimum = Math.max(
                    kernelMinimum,
                    Math.ceil(
                        Math.min(textWidth(name), textWidth('M'.repeat(12))) +
                            textWidth(grid) +
                            padding
                    )
                );
            }
            const otherWidth = columns.reduce(
                (sum, column) => sum + (column.key === 'kernel' ? 0 : column.width),
                Number.parseFloat(getComputedStyle(expandColumn).width)
            );
            kernel.width = Math.min(
                kernel.width,
                Math.max(kernelMinimum, container.clientWidth - otherWidth)
            );
            table!.style.minWidth = `${otherWidth + kernelMinimum}px`;
            for (const column of columns) {
                // PC is the only unspecified column and receives any surplus width.
                if (column.key !== 'pc') column.element.style.width = `${column.width}px`;
            }
        }

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        document.fonts.addEventListener('loadingdone', measure);
        return () => {
            observer.disconnect();
            document.fonts.removeEventListener('loadingdone', measure);
        };
    }, [tableRef, warps]);
}
