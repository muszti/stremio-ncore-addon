import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { TorrentStoreStats } from '@server/services/torrent-store';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TORRENTS_QUERY_KEY } from '../constants';

export const ForceDownloadButton = ({ torrent }: { torrent: TorrentStoreStats }) => {
  const queryClient = useQueryClient();
  const { mutate: downloadAll, isPending } = useMutation({
    mutationFn: async () => {
      const req = await api.torrents[':infoHash'].download.$post({
        param: { infoHash: torrent.hash },
      });
      const res = await req.json();
      if (!res.success) throw Error(res.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [TORRENTS_QUERY_KEY] }),
    onError: (error) => window.alert(`Failed to force full download.\n${error.message}`),
  });

  return (
    <Button size="sm" disabled={isPending} onClick={() => downloadAll()}>
      Download 100%
    </Button>
  );
};
