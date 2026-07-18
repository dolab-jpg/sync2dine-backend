import { saveCall } from '../server/data-store.ts';
import {
  handleCallRecordingApi,
  handleCallRefreshFromProviderApi,
  handleCallsListApi,
} from '../server/phone-webhook.ts';

const callId = `probe-rec-${Date.now()}`;
saveCall({
  id: callId,
  direction: 'inbound',
  from: '+447700900999',
  to: '+442037453233',
  status: 'completed',
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  transcript: [],
  recordingUrl: 'https://example.com/fake-recording.wav',
  metadata: { partyPhone: '+447700900999', lineDid: '+442037453233', vapiCallId: '' },
});

function mockRes() {
  const headers = {};
  return {
    statusCode: 0,
    headers,
    setHeader(k, v) {
      headers[k] = v;
    },
    end(body) {
      this.body = body;
    },
  };
}

const listRes = mockRes();
await handleCallsListApi(
  { method: 'GET', headers: {}, url: '/api/calls?limit=50' },
  listRes,
  new URL('http://x/api/calls?limit=50'),
);
const list = JSON.parse(listRes.body);
const row = list.calls.find((c) => c.id === callId);
console.log('list enrich', {
  displayPhone: row?.displayPhone,
  hasRecording: row?.hasRecording,
  playback: row?.recordingPlaybackPath,
});

const recRes = mockRes();
await handleCallRecordingApi(
  { method: 'GET', headers: {}, url: `/api/calls/${callId}/recording` },
  recRes,
  callId,
);
console.log('recording', recRes.statusCode, recRes.headers.Location || recRes.headers.location);

const refRes = mockRes();
await handleCallRefreshFromProviderApi({ method: 'POST', headers: {} }, refRes, callId);
console.log('refresh', refRes.statusCode, String(refRes.body || '').slice(0, 240));
console.log('smoke ok');
