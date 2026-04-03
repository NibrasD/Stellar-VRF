import { useListVrfRequests, useCreateVrfRequest, getListVrfRequestsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Copy, ArrowRight, Loader2, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  alphaSeed: z.string().min(10, "Seed must be at least 10 characters"),
  requesterAddress: z.string().min(56, "Invalid Soroban address").max(56),
});

export default function RequestsList() {
  const { data: requests, isLoading } = useListVrfRequests();
  const createRequest = useCreateVrfRequest();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      alphaSeed: "0x" + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join(''),
      requesterAddress: "C" + Array.from({length: 55}, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random()*32)]).join(''),
    },
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    createRequest.mutate(
      { data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVrfRequestsQueryKey() });
          setIsCreateOpen(false);
          toast({
            title: "Request Created",
            description: "VRF Request has been successfully submitted.",
          });
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: error.error || "Failed to create request",
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">VRF Requests</h1>
          <p className="text-muted-foreground mt-1">All submitted randomness requests</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="font-mono">
              <Plus className="w-4 h-4 mr-2" />
              New Request
            </Button>
          </DialogTrigger>
          <DialogContent className="border-border bg-card">
            <DialogHeader>
              <DialogTitle>Create VRF Request</DialogTitle>
              <DialogDescription>
                Submit a new seed to the VRF oracle to generate verifiable randomness.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="alphaSeed"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Alpha Seed (Hex)</FormLabel>
                      <FormControl>
                        <Input placeholder="0x..." className="font-mono text-xs" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="requesterAddress"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Requester Address (Contract)</FormLabel>
                      <FormControl>
                        <Input placeholder="C..." className="font-mono text-xs" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter className="mt-6">
                  <Button type="submit" disabled={createRequest.isPending}>
                    {createRequest.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Submit Request
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border/50 bg-card/30 backdrop-blur-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="w-[100px]">ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Seed</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-primary" />
                    Loading requests...
                  </TableCell>
                </TableRow>
              ) : requests?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    No requests found. Create one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                requests?.map((req) => (
                  <TableRow key={req.id} className="border-border group">
                    <TableCell className="font-mono font-medium">#{req.id}</TableCell>
                    <TableCell>
                      <StatusBadge status={req.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                      {req.alphaSeed}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {format(new Date(req.createdAt), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link href={`/requests/${req.id}`}>
                        <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
                          View Details
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

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'fulfilled':
      return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">Fulfilled</Badge>;
    case 'pending':
      return <Badge variant="outline" className="bg-secondary text-secondary-foreground border-secondary/50">Pending</Badge>;
    case 'failed':
      return <Badge variant="destructive" className="bg-destructive/20 text-destructive border-destructive/30">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}