import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { TransferQueue, type TransferQueueProps } from "@/features/transfers/TransferQueue";

type TransferQueueDialogProps = TransferQueueProps & {
  open: boolean;
  onClose: () => void;
};

export function TransferQueueDialog({ open, onClose, ...queueProps }: TransferQueueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-5 py-3 text-left">
          <DialogTitle className="text-sm font-semibold">传输队列</DialogTitle>
        </DialogHeader>
        <div data-scroll-container className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <TransferQueue {...queueProps} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
