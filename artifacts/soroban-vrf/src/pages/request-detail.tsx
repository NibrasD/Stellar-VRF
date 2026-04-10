import { useParams } from "wouter";
import { useGetVrfRequest, useFulfillVrfRequest, getGetVrfRequestQueryKey, getListVrfRequestsQueryKey, getListVrfProofsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./requests";
import { ArrowLeft, ArrowRight, Cpu, Zap, Activity, Loader2, CheckCircle2, Shield } from "lucide-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export default function RequestDetail() {
  const params = useParams();
  const id = parseInt(params.id || "0");
  const { data: request, isLoading } = useGetVrfRequest(id, { query: { enabled: !!id, queryKey: getGetVrfRequestQueryKey(id) } });
  const fulfillMutation = useFulfillVrfRequest();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!request) {
    return <div>Request not found</div>;
  }

  const handleFulfill = () => {
    fulfillMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetVrfRequestQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getListVrfRequestsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListVrfProofsQueryKey() });
          toast({
            title: "Request Fulfilled",
            description: "VRF Proof generated and randomness provided.",
          });
        },
        onError: (error) => {
          toast({
            title: "Fulfillment Failed",
            description: (error as any).data?.error || "An error occurred during fulfillment.",
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center space-x-4 mb-4">
        <Link href="/requests">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            Request #{request.id}
            <StatusBadge status={request.status} />
          </h1>
        </div>
        <div className="flex-1" />
        {request.status === 'pending' && (
          <Button 
            onClick={handleFulfill} 
            disabled={fulfillMutation.isPending}
            className="font-mono font-bold tracking-widest shadow-[0_0_15px_rgba(0,255,255,0.3)] hover:shadow-[0_0_25px_rgba(0,255,255,0.5)] transition-shadow"
          >
            {fulfillMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
            EXECUTE FULFILLMENT
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="border-border/50 bg-card/30 backdrop-blur-sm">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
              <Activity className="w-4 h-4 mr-2 text-primary" />
              Request Payload
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <DataRow label="Alpha Seed" value={request.alphaSeed} isHex />
            <DataRow label="Requester" value={request.requesterAddress} isHex={false} />
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Oracle Contract (Stellar Testnet)</p>
              <div className="flex items-center gap-2 p-2 rounded bg-black/40 border border-border/50 font-mono text-[11px] break-all text-primary/80">
                <span>{request.contractAddress}</span>
                <a
                  href={`https://stellar.expert/explorer/testnet/contract/${request.contractAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-primary hover:text-primary/60 transition-colors"
                  title="View on stellar.expert"
                >
                  <ArrowRight className="w-3 h-3 rotate-[-45deg]" />
                </a>
              </div>
            </div>
            {(request as any).requestTxHash && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">On-Chain Request Tx</p>
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${(request as any).requestTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-2 rounded bg-primary/5 border border-primary/20 font-mono text-[11px] break-all text-primary hover:bg-primary/10 transition-colors"
                >
                  {(request as any).requestTxHash}
                </a>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Created At</p>
                <p className="font-mono text-sm">{format(new Date(request.createdAt), "yyyy-MM-dd HH:mm:ss")}</p>
              </div>
              {request.fulfilledAt && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Fulfilled At</p>
                  <p className="font-mono text-sm">{format(new Date(request.fulfilledAt), "yyyy-MM-dd HH:mm:ss")}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className={`border-border/50 backdrop-blur-sm ${request.status === 'fulfilled' ? 'bg-primary/5 border-primary/20' : 'bg-card/30'}`}>
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
              <Shield className="w-4 h-4 mr-2 text-primary" />
              Oracle Output
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {request.status === 'pending' ? (
              <div className="h-[200px] flex flex-col items-center justify-center text-muted-foreground space-y-4">
                <Cpu className="w-12 h-12 opacity-20" />
                <p className="text-sm font-mono text-center max-w-[250px]">Waiting for oracle execution to generate randomness and proof.</p>
              </div>
            ) : request.status === 'failed' ? (
              <div className="h-[200px] flex flex-col items-center justify-center text-destructive space-y-4">
                <p className="text-sm font-mono text-center">Fulfillment failed. Simulation reverted.</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Random Output</p>
                  <div className="bg-black/50 p-4 rounded-md border border-primary/30 relative group overflow-hidden">
                    <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                    <p className="font-mono text-lg text-primary break-all glow-text leading-tight">{request.randomOutput}</p>
                  </div>
                </div>
                <DataRow label="Gas Estimate" value={`${request.gasEstimate} stroops`} isHex={false} />
                
                {request.proof && (
                  <div className="pt-4 mt-4 border-t border-border/50">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-foreground">ECVRF Proof Generated</p>
                      <Link href={`/verify/${request.proof.id}`}>
                        <Button variant="outline" size="sm" className="font-mono text-xs h-8 border-primary/30 hover:bg-primary/10">
                          Verify Proof <ArrowRight className="w-3 h-3 ml-2" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DataRow({ label, value, isHex = false }: { label: string, value: string, isHex?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <div className={`p-2.5 rounded bg-black/40 border border-border/50 ${isHex ? 'font-mono text-xs break-all text-primary/80' : 'font-mono text-sm'}`}>
        {value}
      </div>
    </div>
  );
}