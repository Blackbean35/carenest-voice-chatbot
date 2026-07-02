# 온디바이스 TTS 워커 (Windows SAPI). Expo RN 앱에서는 expo-speech가 이 역할을 합니다.
# stdin으로 문장을 한 줄씩 받아 즉시 읽고, 다 읽으면 stdout에 __DONE__ 를 출력합니다.
Add-Type -AssemblyName System.Speech
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('Microsoft Heami Desktop') } catch {}  # 한국어 음성(있으면)
$s.Rate = 1
[Console]::Out.WriteLine('__READY__')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $s.Speak($line)
  [Console]::Out.WriteLine('__DONE__')
}
