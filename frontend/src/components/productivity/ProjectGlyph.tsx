import {
  Book,
  Briefcase,
  Folder,
  Heart,
  Sparkles,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { ProjectIcon } from '../../types';

const ICONS: Record<ProjectIcon, LucideIcon> = {
  folder: Folder,
  briefcase: Briefcase,
  book: Book,
  heart: Heart,
  wallet: Wallet,
  sparkles: Sparkles,
};

export function ProjectGlyph({
  icon,
  className,
}: {
  icon: ProjectIcon;
  className?: string;
}) {
  const Icon = ICONS[icon] || Folder;
  return <Icon className={className} aria-hidden="true" />;
}
