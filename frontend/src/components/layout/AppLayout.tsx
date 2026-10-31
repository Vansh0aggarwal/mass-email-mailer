import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { WorkspaceHeader } from './WorkspaceHeader';
import { RightSidebar } from './RightSidebar';
import { BottomNavigation } from './BottomNavigation';
import { CommandPalette } from './CommandPalette';
import { ProductivityProvider } from '../../context/ProductivityContext';
import { ProductivityWindowHost } from '../productivity/ProductivityWindowHost';

export function AppLayout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const location = useLocation();
  const isEmailWorkspace = location.pathname === '/email' || location.pathname.startsWith('/email/');

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location.pathname]);

  // Global Cmd+K / Ctrl+K shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <ProductivityProvider>
      <div className="app-shell">
        <section className="app-shell-main" aria-label="Workspace">
          <WorkspaceHeader
            onMenuClick={() => setIsSidebarOpen(true)}
            onOpenSearch={() => setIsCommandPaletteOpen(true)}
          />
          <main
            className={
              isEmailWorkspace
                ? 'flex min-h-0 flex-1 flex-col p-2 pb-24 sm:p-3 sm:pb-24'
                : 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 pb-28 sm:p-4 lg:p-6 lg:pb-28'
            }
          >
            <Outlet />
          </main>
        </section>

        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
        <RightSidebar />
        <BottomNavigation onOpenSearch={() => setIsCommandPaletteOpen(true)} />

        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setIsCommandPaletteOpen(false)}
        />
      </div>

      <ProductivityWindowHost />
    </ProductivityProvider>
  );
}
