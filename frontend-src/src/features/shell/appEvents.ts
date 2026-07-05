import type { Toast } from "@/components/app/toast";

export type AppEvents = {
  toast: Omit<Toast, "id">;
  refreshTransfers: undefined;
};
