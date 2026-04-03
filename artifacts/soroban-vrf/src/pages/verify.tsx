import { useParams, Link } from "wouter";
import { useListVrfProofs, useVerifyVrfProof, getListVrfProofsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Cpu, Play, CheckCircle2, XCircle, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { VerificationBadge } from "./proofs";
import { useState } from "react";

export default function VerifySimulator() {
  const params = useParams();
  const id = parseInt(params.id || "0");
  const { data: proofs, isLoading } = useListVrfProofs();
  const verifyMutation = useVerifyVrfProof();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const proof = proofs?.find(p => p.id === id);
  const [activeStep, setActiveStep] = useState<number | null>(null);

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!proof) {
    return <div>Proof not found</div>;
  }

  const steps = proof.verificationSteps ? JSON.parse(proof.verificationSteps) : [];

  const handleVerify = () => {
    setActiveStep(1);
    verifyMutation.mutate(
      { id },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListVrfProofsQueryKey() });
          // Could animate steps here if we wanted a cooler effect
          toast({
            title: result.valid ? "Verification Successful" : "Verification Failed",
            description: `Gas used: ${result.gasUsed} stroops`,
            variant: result.valid ? "default" : "destructive",
          });
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: error.error || "Simulation failed to execute.",
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center space-x-4 mb-4">
        <Link href="/proofs">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            Proof Verification Simulator
            <VerificationBadge status={proof.verificationStatus} />
          </h1>
          <p className="text-muted-foreground text-sm font-mono mt-1">PRF #{proof.id} for REQ #{proof.requestId}</p>
        </div>
        <div className="flex-1" />
        <Button 
          onClick={handleVerify} 
          disabled={verifyMutation.isPending || proof.verificationStatus === 'verified'}
          className="font-mono shadow-[0_0_15px_rgba(0,255,255,0.2)]"
        >
          {verifyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
          RUN ON-CHAIN SIMULATION
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card className="border-border/50 bg-card/30 backdrop-blur-sm">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
                <Cpu className="w-4 h-4 mr-2 text-primary" />
                Proof Components
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-4">
              <ComponentRow label="Gamma Point (Γ)" value={proof.gammaPoint} />
              <ComponentRow label="Challenge Scalar (c)" value={proof.challengeScalar} />
              <ComponentRow label="Response Scalar (s)" value={proof.responseScalar} />
              <ComponentRow label="Public Key (pk)" value={proof.publicKey} />
              
              <div className="pt-4 mt-4 border-t border-border/50">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Serialized Proof (Bytes)</p>
                <div className="bg-black/60 p-3 rounded text-[10px] font-mono text-primary/60 break-all leading-relaxed max-h-32 overflow-y-auto custom-scrollbar">
                  {proof.proofBytes}
                </div>
              </div>

              {(proof as any).fulfillTxHash && (
                <div className="pt-4 mt-4 border-t border-border/50">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">On-Chain Fulfill Tx</p>
                  <a
                    href={(proof as any).onChainExplorerUrl || `https://stellar.expert/explorer/testnet/tx/${(proof as any).fulfillTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-2 rounded bg-primary/5 border border-primary/20 font-mono text-[10px] break-all text-primary hover:bg-primary/10 transition-colors"
                  >
                    <ShieldCheck className="w-3 h-3 shrink-0" />
                    {(proof as any).fulfillTxHash}
                  </a>
                  <p className="text-[10px] text-muted-foreground mt-1">Click to view this proof transaction on Stellar Expert</p>
                </div>
              )}
              {!(proof as any).fulfillTxHash && proof.verificationStatus === 'verified' && (
                <div className="pt-3 mt-3 border-t border-border/50">
                  <p className="text-[10px] text-muted-foreground">On-chain tx hash pending — the Soroban contract submission runs asynchronously. Reload in a few seconds.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm h-full">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground uppercase flex items-center">
                <ShieldCheck className="w-4 h-4 mr-2 text-primary" />
                Verification Execution Trace
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {proof.verificationStatus === 'unverified' && !verifyMutation.isPending && !verifyMutation.data ? (
                <div className="h-[300px] flex flex-col items-center justify-center text-muted-foreground border-2 border-dashed border-border/50 rounded-lg bg-black/20">
                  <Play className="w-12 h-12 opacity-20 mb-4" />
                  <p className="font-mono text-sm max-w-sm text-center">Ready to simulate Soroban contract execution. This will verify the ECVRF proof against the original seed.</p>
                  <Button variant="outline" className="mt-6 font-mono text-xs border-primary/50 text-primary hover:bg-primary/10" onClick={handleVerify}>
                    Start Simulation
                  </Button>
                </div>
              ) : (
                <div className="space-y-6 relative before:absolute before:inset-0 before:ml-4 before:-translate-x-px before:h-full before:w-0.5 before:bg-border/50">
                  {steps.map((step: any) => (
                    <div key={step.stepNumber} className="relative flex items-start gap-4">
                      <div className={`mt-1 flex items-center justify-center w-8 h-8 rounded-full border-2 bg-background z-10 shrink-0 ${
                        step.passed ? 'border-primary text-primary shadow-[0_0_10px_rgba(0,255,255,0.3)]' : 
                        step.passed === false ? 'border-destructive text-destructive' : 'border-muted text-muted'
                      }`}>
                        {step.passed ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                      </div>
                      <div className={`p-4 rounded-md border w-full transition-colors ${
                        step.passed ? 'bg-primary/5 border-primary/20' : 
                        step.passed === false ? 'bg-destructive/5 border-destructive/30' : 'bg-card/50 border-border/50'
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <h4 className="font-bold font-mono text-sm">{step.stepNumber}. {step.name}</h4>
                          {step.passed ? (
                            <span className="text-[10px] uppercase font-bold tracking-widest text-primary px-2 py-0.5 rounded bg-primary/10">Passed</span>
                          ) : (
                            <span className="text-[10px] uppercase font-bold tracking-widest text-destructive px-2 py-0.5 rounded bg-destructive/10">Failed</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">{step.description}</p>
                        <div className="bg-black/40 border border-border/50 p-2.5 rounded font-mono text-xs text-foreground/80 break-all">
                          {step.detail}
                        </div>
                      </div>
                    </div>
                  ))}
                  
                  {verifyMutation.isPending && (
                    <div className="relative flex items-start gap-4 animate-pulse">
                      <div className="mt-1 flex items-center justify-center w-8 h-8 rounded-full border-2 border-primary/50 text-primary/50 bg-background z-10 shrink-0">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                      <div className="p-4 rounded-md border border-primary/20 bg-primary/5 w-full">
                        <div className="h-4 w-1/3 bg-primary/20 rounded mb-2"></div>
                        <div className="h-3 w-2/3 bg-muted/20 rounded"></div>
                      </div>
                    </div>
                  )}

                  {verifyMutation.data && (
                    <div className="pt-6 mt-6 border-t border-border border-dashed text-center">
                      {verifyMutation.data.valid ? (
                        <div className="inline-flex items-center px-4 py-2 rounded-full border border-primary/50 bg-primary/10 text-primary font-mono font-bold text-sm shadow-[0_0_20px_rgba(0,255,255,0.2)]">
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          VERIFICATION SUCCESSFUL — {verifyMutation.data.gasUsed} STROOPS
                        </div>
                      ) : (
                        <div className="inline-flex items-center px-4 py-2 rounded-full border border-destructive/50 bg-destructive/10 text-destructive font-mono font-bold text-sm">
                          <AlertTriangle className="w-4 h-4 mr-2" />
                          VERIFICATION FAILED
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ComponentRow({ label, value }: { label: string, value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <div className="p-2 rounded bg-black/40 border border-border/50 font-mono text-[11px] break-all text-primary/80">
        {value}
      </div>
    </div>
  );
}