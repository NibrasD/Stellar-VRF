import React from "react";
import { useGetDashboardStats, useGetRandomnessDistribution, useGetRecentActivity, useGetStellarNetwork, useGetDrandLatest } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bar, BarChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { Activity, Clock, Zap, CheckCircle2, Shield, Globe, Layers, Hash, Server, Radio, ShieldCheck, RefreshCw, ExternalLink, Info, Lock } from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: distribution, isLoading: distLoading } = useGetRandomnessDistribution();
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity();
  const { data: stellar, isLoading: stellarLoading } = useGetStellarNetwork({
    query: { refetchInterval: 10000 },
  });
  const { data: drand, isLoading: drandLoading, refetch: refetchDrand, isFetching: drandFetching } = useGetDrandLatest(
    { chain: "quicknet" },
    { query: { refetchInterval: 6000 } },
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Status</h1>
          <p className="text-muted-foreground mt-1">Real-time VRF oracle metrics</p>
        </div>
        {/* Live Stellar Network Badge */}
        {stellar && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-xs font-mono text-primary">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            Stellar {stellar.stats?.networkPassphrase?.includes("Test") ? "Testnet" : "Mainnet"} Live
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Requests"
          value={stats?.totalRequests}
          icon={Activity}
          loading={statsLoading}
        />
        <StatCard
          title="Proof Success Rate"
          value={stats ? `${stats.proofSuccessRate.toFixed(2)}%` : undefined}
          icon={CheckCircle2}
          loading={statsLoading}
          highlight
        />
        <StatCard
          title="Avg Fulfillment Time"
          value={stats ? `${stats.avgFulfillmentTimeMs}ms` : undefined}
          icon={Clock}
          loading={statsLoading}
        />
        <StatCard
          title="Avg Gas Used"
          value={stats?.avgGasPerVerification}
          icon={Zap}
          loading={statsLoading}
        />
      </div>

      {/* drand Distributed Randomness Beacon Panel */}
      <Card className="border-primary/30 bg-card/50 backdrop-blur-sm shadow-[0_0_20px_rgba(0,255,255,0.06)]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center gap-2">
            <Radio className="w-4 h-4 text-primary" />
            drand — League of Entropy Distributed Beacon
            {drand && (
              <span className="flex items-center gap-1 ml-auto text-[10px] font-mono text-primary/60 normal-case">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                quicknet · {drand.chain.period}s period
                <button
                  onClick={() => refetchDrand()}
                  disabled={drandFetching}
                  className="ml-2 hover:text-primary transition-colors"
                  title="Refresh beacon"
                >
                  <RefreshCw className={`w-3 h-3 ${drandFetching ? "animate-spin" : ""}`} />
                </button>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Why drand solves the NebulaVRF problem */}
          <div className="flex items-start gap-3 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
            <ShieldCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <span className="text-foreground font-medium">Why drand?</span>{" "}
              Commit-reveal schemes (like NebulaVRF) let the operator pre-choose the seed and manipulate outcomes.
              drand's <span className="text-primary">threshold BLS signature</span> requires a quorum of independent nodes (Cloudflare, EPFL, Protocol Labs…)
              — no single party controls the output, making it impossible for our oracle to bias the VRF result.
              Use the <span className="text-primary">suggestedAlphaSeed</span> below as your alpha input when creating a request.
            </p>
          </div>

          {drandLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                  <div className="h-6 w-28 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : drand ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StellarStat icon={Hash} label="Round" value={`#${drand.beacon.round.toLocaleString()}`} />
                <StellarStat icon={Clock} label="Next beacon" value={`in ${drand.secondsUntilNext}s`} />
                <StellarStat icon={Layers} label="Scheme" value={drand.chain.schemeId.split("-")[0]} />
                <StellarStat icon={Radio} label="Chain" value="quicknet · G2" />
              </div>
              {/* Randomness hex + external verify link */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                    randomness = SHA256(threshold_BLS_sig)
                  </p>
                  <a
                    href={`https://api.drand.sh/${drand.chain.hash}/public/${drand.beacon.round}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] font-mono text-primary hover:text-primary/80 transition-colors"
                  >
                    Verify raw JSON <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <div className="font-mono text-[11px] text-primary break-all leading-relaxed p-3 rounded border border-primary/20 bg-primary/5">
                  {drand.beacon.randomness}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Click "Verify raw JSON" above → the browser will fetch this exact round directly from drand's servers — no middleman.
                </p>
              </div>
              {/* Suggested alpha seed */}
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                  suggestedAlphaSeed — use this in New Request for trustless VRF
                </p>
                <div className="font-mono text-[11px] text-foreground/80 break-all leading-relaxed p-3 rounded border border-border/50 bg-muted/20">
                  {drand.suggestedAlphaSeed}
                </div>
              </div>
            </>
          ) : (
            <div className="py-4 text-sm text-muted-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-destructive" />
              drand network unreachable
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live Stellar Network Panel */}
      <Card className="border-primary/20 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Stellar Network — Live Horizon Data
            {stellar && (
              <span className="ml-auto flex items-center gap-2 text-[10px] font-mono text-primary/60 normal-case">
                refreshes every 10s
                <a
                  href={`https://stellar.expert/explorer/testnet/ledger/${stellar.stats?.latestLedger}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-0.5 hover:text-primary transition-colors"
                >
                  stellar.expert <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stellarLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                  <div className="h-6 w-28 bg-muted animate-pulse rounded" />
                </div>
              ))}
            </div>
          ) : stellar ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StellarStat icon={Layers} label="Latest Ledger" value={stellar.stats?.latestLedger?.toLocaleString() ?? "—"} />
                <StellarStat icon={Hash} label="Base Fee (XLM)" value={stellar.stats?.baseFeeInXLM != null ? stellar.stats.baseFeeInXLM.toFixed(7) : "—"} />
                <StellarStat icon={Server} label="Soroban Fee (stroops)" value={stellar.fee?.totalStroops?.toLocaleString() ?? "—"} />
                <StellarStat icon={Clock} label="Recent Ledgers" value={`${stellar.ledgers?.length ?? 0} loaded`} />
              </div>
              {/* Recent ledgers mini table */}
              {stellar.ledgers && stellar.ledgers.length > 0 && (
                <div className="mt-2 overflow-auto max-h-[180px] rounded border border-border/40">
                  <table className="w-full text-[11px] font-mono">
                    <thead className="sticky top-0 bg-card border-b border-border/40">
                      <tr className="text-muted-foreground">
                        <th className="text-left px-3 py-2">Sequence</th>
                        <th className="text-left px-3 py-2">Closed At</th>
                        <th className="text-right px-3 py-2">Ops</th>
                        <th className="text-right px-3 py-2">Base Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stellar.ledgers.map((ledger, i) => (
                        <tr
                          key={ledger.sequence}
                          className={`border-b border-border/20 ${i === 0 ? "text-primary" : "text-foreground/70"} hover:bg-muted/20 transition-colors`}
                        >
                          <td className="px-3 py-1.5 font-bold">
                            <a
                              href={`https://stellar.expert/explorer/testnet/ledger/${ledger.sequence}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline flex items-center gap-1"
                            >
                              {ledger.sequence?.toLocaleString()}
                              <ExternalLink className="w-2.5 h-2.5 opacity-50" />
                            </a>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">
                            {ledger.closedAt ? formatDistanceToNow(new Date(ledger.closedAt), { addSuffix: true }) : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-right">{ledger.operationCount ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right">{ledger.baseFee ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="py-4 text-sm text-muted-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-destructive" />
              Stellar Horizon unreachable
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Transparency & Proof-of-Realness Card ─────────────────────── */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-3 border-b border-border/50">
          <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            Transparency — What Is Real vs. What Is Not Yet On-Chain
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Real */}
            <TransparencyItem
              icon={<CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
              label="ECVRF Cryptography"
              status="Real — 100%"
              statusColor="text-green-400"
              description="ECVRF-SECP256K1-SHA256-TAI implemented with @noble/curves v2. No simulation. All 6 verification steps use real EC point arithmetic."
              links={[
                { label: "View vrfCrypto.ts on GitHub", href: "https://github.com/paulmillr/noble-curves" },
              ]}
            />
            <TransparencyItem
              icon={<CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
              label="drand Randomness Beacon"
              status="Real — Live Network"
              statusColor="text-green-400"
              description="Threshold BLS beacon from the League of Entropy (Cloudflare, EPFL, Protocol Labs…). Click the round number link in the panel above — it opens drand's own API directly."
              links={[
                { label: "drand.love", href: "https://drand.love" },
                { label: "api.drand.sh", href: "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info" },
              ]}
            />
            <TransparencyItem
              icon={<CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
              label="Stellar Horizon Ledgers"
              status="Real — Live Testnet"
              statusColor="text-green-400"
              description="Ledger sequences, fees, and timestamps come directly from Stellar's Horizon API (horizon-testnet.stellar.org). Every ledger row above links to stellar.expert for independent confirmation."
              links={[
                { label: "Stellar Testnet Explorer", href: "https://stellar.expert/explorer/testnet" },
                { label: "Horizon Testnet API", href: "https://horizon-testnet.stellar.org/ledgers?limit=5&order=desc" },
              ]}
            />
          </div>
          <TransparencyItem
            icon={<CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
            label="Soroban Smart Contract"
            status="DEPLOYED — Stellar Testnet"
            statusColor="text-green-400"
            description="VRF Oracle contract v2 deployed on Stellar Testnet with full access control. fulfill() enforces require_auth() (only oracle can call), verifies proof.public_key matches stored PK, and validates Ed25519 signature on proof data on-chain."
            links={[
              { label: "View contract on stellar.expert", href: "https://stellar.expert/explorer/testnet/contract/CDCCS572SSTPLWT75MGOG4JKUUFXV7MCJ2DQ6X63NEEKS4GNEWGQGSW3" },
              { label: "Oracle account", href: "https://stellar.expert/explorer/testnet/account/GARPMPBJ5H43UNYHLIC46MSYRDGF4ZNKUYTZYDYVW5S2TUORAMBZRAMI" },
            ]}
          />
          <div className="mt-3 pt-3 border-t border-border/50 flex items-start gap-3 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
            <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <span className="text-primary font-medium">3-layer on-chain security:</span>{" "}
              (1) <code className="text-primary">require_auth()</code> — only the registered oracle address can call fulfill,{" "}
              (2) PK match — contract verifies proof.public_key matches the stored oracle secp256k1 key,{" "}
              (3) Ed25519 signature — oracle signs proof data, contract verifies via <code className="text-primary">env.crypto().ed25519_verify()</code> on-chain.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Randomness Distribution Chart */}
        <Card className="col-span-1 lg:col-span-2 border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
              <Shield className="w-4 h-4 mr-2 text-primary" />
              Randomness Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              {distLoading ? (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">Loading chart data...</div>
              ) : distribution ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={distribution}>
                    <XAxis
                      dataKey="bucket"
                      stroke="#888888"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#888888"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => `${value}`}
                    />
                    <RechartsTooltip
                      cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-popover border border-border p-3 rounded-md shadow-xl">
                              <p className="text-sm font-mono text-muted-foreground mb-1">Bucket: {payload[0].payload.bucket}</p>
                              <p className="text-primary font-mono font-bold">Count: {payload[0].value}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {payload[0].payload.percentage.toFixed(2)}% of total
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground">No data available</div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card className="col-span-1 border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
              <Activity className="w-4 h-4 mr-2 text-primary" />
              Activity Log
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2">
            <div className="space-y-0 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
              {activityLoading ? (
                <div className="py-4 text-center text-muted-foreground text-sm">Syncing feed...</div>
              ) : activity?.map((item) => (
                <div key={item.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active py-3 px-4">
                  <div className="flex items-center justify-center w-2 h-2 rounded-full border border-primary bg-background shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-primary/20 z-10 ml-4 md:ml-0" />
                  <div className="w-[calc(100%-3rem)] md:w-[calc(50%-1.5rem)] ml-4 md:ml-0 p-3 rounded border border-border/50 bg-card/30 hover:bg-card/80 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-primary truncate max-w-[70%]">{item.type}</span>
                      <time className="text-[10px] text-muted-foreground tabular-nums">
                        {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
                      </time>
                    </div>
                    <p className="text-xs text-foreground/80 break-words">{item.description}</p>
                    <div className="mt-2 flex gap-2">
                      {item.requestId && (
                        <Link href={`/requests/${item.requestId}`}>
                          <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded cursor-pointer hover:bg-primary/20 transition-colors">
                            REQ #{item.requestId}
                          </span>
                        </Link>
                      )}
                      {item.proofId && (
                        <Link href={`/verify/${item.proofId}`}>
                          <span className="text-[10px] bg-secondary text-secondary-foreground px-2 py-0.5 rounded cursor-pointer hover:bg-secondary/80 transition-colors">
                            PRF #{item.proofId}
                          </span>
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TransparencyItem({
  icon,
  label,
  status,
  statusColor,
  description,
  links,
}: {
  icon: React.ReactNode;
  label: string;
  status: string;
  statusColor: string;
  description: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-black/20 p-4 space-y-2">
      <div className="flex items-start gap-2">
        {icon}
        <div>
          <p className="text-xs font-bold text-foreground">{label}</p>
          <p className={`text-[10px] font-mono font-bold ${statusColor}`}>{status}</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] font-mono text-primary hover:text-primary/80 transition-colors border border-primary/20 rounded px-2 py-0.5"
          >
            {l.label} <ExternalLink className="w-2.5 h-2.5" />
          </a>
        ))}
      </div>
    </div>
  );
}

function StellarStat({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="w-3 h-3" />
        <span className="text-[11px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-lg font-mono font-bold text-foreground tabular-nums">{value}</p>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  loading,
  highlight = false
}: {
  title: string;
  value?: string | number;
  icon: any;
  loading: boolean;
  highlight?: boolean;
}) {
  return (
    <Card className={`border-border/50 overflow-hidden relative ${highlight ? 'border-primary/30 shadow-[0_0_15px_rgba(0,255,255,0.1)]' : 'bg-card/50'}`}>
      {highlight && (
        <div className="absolute inset-0 bg-primary/5 pointer-events-none"></div>
      )}
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
          <Icon className={`w-4 h-4 ${highlight ? 'text-primary' : 'text-muted-foreground'}`} />
        </div>
        <div className="mt-4">
          {loading ? (
            <div className="h-8 w-24 bg-muted animate-pulse rounded"></div>
          ) : (
            <p className={`text-3xl font-mono font-bold tracking-tight ${highlight ? 'glow-text text-primary' : ''}`}>
              {value ?? "—"}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
