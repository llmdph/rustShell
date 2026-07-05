import { useCallback, useEffect, useRef, useState } from "react";

import { api, type TransferView } from "@/api";
import { sameTransferList } from "@/features/transfers/transferUtils";

export function useTransferState() {
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [transferHistory, setTransferHistory] = useState<TransferView[]>([]);
  const transfersRef = useRef<TransferView[]>([]);

  const refreshTransfers = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    try {
      const [nextTransfers, nextHistory] = await Promise.all([api.listTransfers(), api.listTransferHistory()]);
      transfersRef.current = nextTransfers;
      setTransfers((current) => (sameTransferList(current, nextTransfers) ? current : nextTransfers));
      setTransferHistory((current) => (sameTransferList(current, nextHistory) ? current : nextHistory));
    } catch {
      transfersRef.current = [];
      setTransfers((current) => (current.length === 0 ? current : []));
      setTransferHistory((current) => (current.length === 0 ? current : []));
    }
  }, []);

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
