import { Link, useLocation } from "wouter";
import { Activity, ActivitySquare, ShieldCheck, Cpu, LayoutDashboard, List, FileKey2 } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/requests", label: "Requests", icon: List },
  { href: "/proofs", label: "Proofs", icon: ShieldCheck },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-mono selection:bg-primary/30">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col z-20">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <Cpu className="w-5 h-5 text-primary mr-3" />
          <span className="font-bold tracking-wider text-sm glow-text">SOROBAN_VRF</span>
        </div>
        
        <nav className="flex-1 py-6 px-3 space-y-1 overflow-y-auto">
          <div className="text-xs font-semibold text-muted-foreground mb-4 px-3 uppercase tracking-widest">
            Navigation
          </div>
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;
            
            return (
              <Link key={item.href} href={item.href}>
                <div className={cn(
                  "flex items-center px-3 py-2.5 rounded-sm text-sm transition-all duration-200 cursor-pointer",
                  isActive 
                    ? "bg-primary/10 text-primary border border-primary/20 shadow-[inset_0_0_10px_rgba(0,255,255,0.05)] glow-box" 
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                )}>
                  <Icon className={cn("w-4 h-4 mr-3", isActive ? "text-primary" : "")} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
        
        <div className="p-4 border-t border-border">
          <div className="flex items-center text-xs text-muted-foreground">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse mr-2"></div>
            <span>Network: Testnet</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 overflow-hidden">
        {/* Ambient background effect */}
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/5 via-background to-background"></div>
        
        <div className="flex-1 overflow-y-auto p-8 relative z-10">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}