// A page that opens a WebRTC peer connection, an exfiltration channel with no normal request.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => "window.pc = new RTCPeerConnection(); window.pc.createDataChannel('x');");
