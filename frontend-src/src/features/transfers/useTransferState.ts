import { useCallback, useEffect, useRef, useState } from "react";

import { api, type TransferView } from "@/api";
import { sameTransferList } from "@/features/transfers/transferUtils";

type UseTransferStateOptions = {
  /**
   * True while a surface that renders per-transfer progress (the transfer
   * queue dialog) is visible. When false, polls that only moved the progress
   * counters are dropped before they reach React — during a large transfer
   * that is 2 commits/second on a component tree with no memo boundary, spent
   * rendering two badge numbers that didn't change. `transfersRef` always
   * carries the full latest data for imperative readers.
   */
  detailed?: boolean;
};

export function useTransferState(options?: UseTransferStateOptions) {
  const detailed = options?.detailed ?? false;
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [transferHistory, setTransferHistory] = useState<TransferView[]>([]);
  const transfersRef = useRef<TransferView[]>([]);
  const detailedRef = useRef(detailed);
  detailedRef.current = detailed;

  const refreshTransfers = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    try {
      const [nextTransfers, nextHistory] = await Promise.all([api.listTransfers(), api.listTransferHistory()]);
      transfersRef.current = nextTransfers;
      const includeProgress = detailedRef.current;
      setTransfers((current) =>
        sameTransferList(current, nextTransfers, { includeProgress }) ? current : nextTransfers
      );
      // History entries are finished, so their progress fields never move.
      setTransferHistory((current) => (sameTransferList(current, nextHistory) ? current : nextHistory));
    } catch {
      transfersRef.current = [];
      setTransfers((current) => (current.length === 0 ? current : []));
      setTransferHistory((current) => (current.length === 0 ? current : []));
    }
  }, []);

  // When the detailed surface opens, sync immediately instead of showing the
  // progress numbers from whenever the last structural change happened.
  useEffect(() => {
    if (detailed) void refreshTransfers();
  }, [detailed, refreshTransfers]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const loop = async () => {
      await refreshTransfers();
      if (stopped) return;
      const hasRunning = transfersRef.current.some((transfer) => transfer.status === "running");
      timer = window.setTimeout(loop, hasRunning ? 500 : 2500);
    };
    timer = window.setTimeout(loop, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refreshTransfers]);

  return {
    transfers,
    setTransfers,
    transferHistory,
    setTransferHistory,
    transfersRef,
    refreshTransfers
  };
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
