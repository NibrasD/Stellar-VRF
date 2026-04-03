import { useListVrfProofs } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowRight, Loader2, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";

export default function ProofsList() {
  const { data: proofs, isLoading } = useListVrfProofs();

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cryptographic Proofs</h1>
          <p className="text-muted-foreground mt-1">Generated ECVRF proofs awaiting on-chain verification</p>
        </div>
      </div>

      <Card className="border-border/50 bg-card/30 backdrop-blur-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-[80px]">ID</TableHead>
                <TableHead className="w-[100px]">Request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Public Key</TableHead>
                <TableHead>Computed At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-primary" />
                    Loading proofs...
                  </TableCell>
                </TableRow>
              ) : proofs?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No proofs generated yet.
                  </TableCell>
                </TableRow>
              ) : (
                proofs?.map((proof) => (
                  <TableRow key={proof.id} className="border-border group">
                    <TableCell className="font-mono font-medium">#{proof.id}</TableCell>
                    <TableCell>
                      <Link href={`/requests/${proof.requestId}`}>
                        <span className="font-mono text-xs text-primary hover:underline cursor-pointer">
                          REQ #{proof.requestId}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <VerificationBadge status={proof.verificationStatus} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[150px] truncate">
                      {proof.publicKey}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {format(new Date(proof.computedAt), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/verify/${proof.id}`}>
                        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity border border-transparent group-hover:border-primary/30">
                          Simulator
                          <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  switch (status) {
    case 'verified':
      return (
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 font-mono">
          <ShieldCheck className="w-3 h-3 mr-1" /> VALID
        </Badge>
      );
    case 'unverified':
      return (
        <Badge variant="outline" className="bg-secondary text-secondary-foreground border-secondary/50 font-mono">
          <ShieldQuestion className="w-3 h-3 mr-1" /> UNVERIFIED
        </Badge>
      );
    case 'invalid':
      return (
        <Badge variant="destructive" className="bg-destructive/20 text-destructive border-destructive/30 font-mono">
          <ShieldAlert className="w-3 h-3 mr-1" /> INVALID
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}