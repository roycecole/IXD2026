import AudienceService from './AudienceService.jsx'
import GestureService from './GestureService.jsx'
import VoiceService from './VoiceService.jsx'
import HapticsService from './HapticsService.jsx'
import QualityService from './QualityService.jsx'
import TourService from './TourService.jsx'

// 所有常駐服務的掛載點（App.jsx 只渲染這一個元件，新增服務不必再改 App）
export default function Services() {
  return (
    <>
      <AudienceService />
      <GestureService />
      <VoiceService />
      <HapticsService />
      <QualityService />
      <TourService />
    </>
  )
}
