// WebRTC ICE 設定（host 與遙控端共用）：STUN + 免費公共 TURN relay。
// 會場 Wi-Fi 常有 client isolation 擋 P2P，TURN 可中繼；手機開熱點則多半直連。
export const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
}
