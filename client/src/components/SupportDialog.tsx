const KOFI_URL = "https://ko-fi.com/yourname";

import { Coffee, Heart } from "lucide-react";
import { Dialog } from "./Dialog";

interface SupportDialogProps {
    open: boolean;
    onClose: () => void;
}

export function SupportDialog({ open, onClose }: SupportDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} title="Support DropFlow" testId="support-dialog">
            <div className="flex flex-col items-center text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/25 to-teal-400/20 ring-1 ring-white/10">
          <Heart className="h-7 w-7 text-teal-300" aria-hidden />
        </span>
                <p className="mt-4 text-sm leading-relaxed text-slate-300">
                    DropFlow is free, has no ads, and never sees your files. If it saved you some time, you can
                    support it with a small tip. Thank you!
                </p>
                <a
                    href={KOFI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-teal-400 px-4 py-3 text-sm font-semibold text-navy-950 shadow-lg shadow-sky-500/20 transition hover:brightness-110"
                >
                    <Coffee className="h-4 w-4" aria-hidden />
                    Support on Ko-fi
                </a>
                <p className="mt-3 text-xs text-slate-500">
                    Payments are handled by Ko-fi. DropFlow never sees your payment details.
                </p>
            </div>
        </Dialog>
    );
}