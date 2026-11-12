/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { HexAddress } from '../../debugger/types';

export interface Lane {
    readonly id: number;
    readonly thread?: readonly [number, number, number] | null;
    readonly pc?: HexAddress | null;
    readonly exception?: string | null;
}

export interface Warp {
    readonly sm: number;
    readonly warp: number;
    readonly kernelName: string | null;
    /** Decimal text preserves IDs beyond JavaScript's safe integer range. */
    readonly gridId: string | null;
    readonly block: readonly [number, number, number] | null;
    readonly activeMask: number | null;
    readonly divergentMask: number | null;
    readonly pc: HexAddress | null;
    /** Valid reported lanes only; null means lane data could not be acquired. */
    readonly lanes: readonly Lane[] | null;
    readonly laneError?: string;
}

export interface WarpSnapshot {
    readonly device: { readonly id: number; readonly name: string | null };
    readonly warps: readonly Warp[];
    /** Confirmed focus is independent of masks and reported faults. */
    readonly focus: {
        readonly sm: number;
        readonly warp: number;
        readonly lane: number | null;
    } | null;
}

/** Session lifecycle and data are independent of the frontend's local controls. */
export type WarpViewContent =
    | { readonly kind: 'no-session' }
    | { readonly kind: 'running' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'unavailable'; readonly message: string }
    | { readonly kind: 'error'; readonly message: string }
    | { readonly kind: 'ready'; readonly snapshot: WarpSnapshot; readonly retrying?: boolean };
export type WarpViewState = WarpViewContent & {
    readonly revision: number;
    readonly sessionId?: string;
    readonly stopId?: string;
    /** Confirmed device, including while its inventory is loading or unavailable. */
    readonly deviceId?: number;
    readonly preferences?: ViewPreferences;
    readonly pendingFocus?: FocusTarget;
    readonly focusBlocked?: boolean;
    readonly focusError?: string;
};

export interface FocusTarget {
    readonly sm: number;
    readonly warp: number;
    readonly lane: number;
}
export type SortColumn = 'warp' | 'sm' | 'kernel' | 'block' | 'activeMask' | 'pc';
export interface Sort {
    readonly column: SortColumn;
    readonly direction: 'ascending' | 'descending';
}
export interface ViewPreferences {
    readonly filter: string;
    readonly sort: Sort;
}
export const DEFAULT_PREFERENCES: ViewPreferences = {
    filter: '',
    sort: { column: 'sm', direction: 'ascending' }
};
