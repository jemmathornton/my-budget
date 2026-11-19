// Small line icons (16x16), drawn in the current text colour.

type P = { size?: number };

function Svg({ size = 16, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Logo = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path d="M8 1l7 7-7 7-7-7z" fill="#78b02e" />
    <path d="M8 4.2l3.8 3.8L8 11.8 4.2 8z" fill="#a8d66a" />
  </svg>
);

export const BudgetIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12M6 6v7.5M10 6v7.5" />
  </Svg>
);

export const ReportsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11" />
    <rect x="3.5" y="8" width="2" height="5" />
    <rect x="7" y="4.5" width="2" height="8.5" />
    <rect x="10.5" y="6.5" width="2" height="6.5" />
  </Svg>
);

export const ScheduledIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 4.5V8l2.4 1.6" />
  </Svg>
);

export const PayeesIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.3" />
    <path d="M1.8 13.2c.5-2.4 2.2-3.7 4.2-3.7s3.7 1.3 4.2 3.7" />
    <path d="M10.6 3.6a2.2 2.2 0 010 4.1M12.3 9.9c1 .6 1.7 1.7 1.9 3.3" />
  </Svg>
);

export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </Svg>
);

export const AccountsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2 6.2L8 2.5l6 3.7" />
    <path d="M3.5 7v5M6.5 7v5M9.5 7v5M12.5 7v5M2 13.5h12" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.3" />
    <path d="M10.2 10.2l3.3 3.3" />
  </Svg>
);

export const ImportIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 2v8M5 7l3 3 3-3" />
    <path d="M2.5 11v2.5h11V11" />
  </Svg>
);

export const LockIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
  </Svg>
);

export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 2.5h7l3 3v8H3z" />
    <path d="M5.5 7.5h5M5.5 10h5" />
  </Svg>
);

export const ChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);

export const ChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);

export const ChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M10 4L6 8l4 4" />
  </Svg>
);

export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

export const WarnIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 2l6.5 11.5h-13z" />
    <path d="M8 6.5v3.2M8 11.7v.1" />
  </Svg>
);

export const EyeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);

export const FlagGlyph = '⚑';

export const BoltIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 1.5L3.5 9h4l-1 5.5 6-7.5h-4z" />
  </Svg>
);
