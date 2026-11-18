import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

function icon(paths: ReactNode) {
  return function Icon({ size = '1em', className, ...rest }: IconProps) {
    return (
      <svg aria-hidden="true" className={className} fill="none" focusable="false" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} viewBox="0 0 24 24" width={size} {...rest}>
        {paths}
      </svg>
    );
  };
}

export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const HistoryIcon = icon(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>);
export const LinkIcon = icon(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>);
export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />);
export const ChevronRightIcon = icon(<path d="m9 18 6-6-6-6" />);
export const ArrowLeftIcon = icon(<path d="m12 19-7-7 7-7M19 12H5" />);
export const SendIcon = icon(<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>);
export const SearchIcon = icon(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>);
export const FileTextIcon = icon(<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5M16 13H8M16 17H8M10 9H8" /></>);
export const FileDiffIcon = icon(<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5M9 10h6M12 7v6M9 17h6" /></>);
export const FolderIcon = icon(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);
export const TerminalIcon = icon(<><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>);
export const AlertIcon = icon(<><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" /><path d="M12 9v4M12 17h.01" /></>);
export const FoldIcon = icon(<><path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2" /><path d="m15 19-3-3-3 3M15 5l-3 3-3-3" /></>);
export const LoaderIcon = icon(<path d="M21 12a9 9 0 1 1-6.2-8.6" />);
export const ListTodoIcon = icon(<><rect height="6" rx="1" width="6" x="3" y="5" /><path d="m3 17 2 2 4-4M13 6h8M13 12h8M13 18h8" /></>);
export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);
export const CircleIcon = icon(<circle cx="12" cy="12" r="9" />);
export const CircleDotIcon = icon(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" fill="currentColor" /></>);
export const XIcon = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const TrashIcon = icon(<><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>);
export const PaperclipIcon = icon(<path d="m21.4 11-8.6 8.6a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.5a2 2 0 0 1-2.8-2.8l8-8" />);
export const GridIcon = icon(<><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>);
export const InfinityIcon = icon(<path d="M12 12c-2-2.7-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.3 6-4Zm0 0c2 2.7 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.3-6 4Z" />);
export const ExternalIcon = icon(<><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
export const MessageIcon = icon(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />);
