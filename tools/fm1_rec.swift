// SPDX-License-Identifier: GPL-3.0-only
// fm1_rec NAME OUT.wav: record the CoreAudio input device NAME (the FM-1's USB audio: "Matryoshka") with AVAudioEngine at
// the device's own rate into a 16-bit WAV, until a line arrives on stdin (or stdin closes). It prints "rec RATE CHANNELS"
// once the first buffer came, and at the end "frames N seconds S". web/scripts/audio-capture.mjs builds and runs it for the
// device check's scenarios: ffmpeg's avfoundation input delivered about a third of the FM-1's buffers (9.2 s of a 30 s
// capture on 2026-11-06), where this records them all (44049 frames a second over 30 s).
import AVFoundation
import CoreAudio

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("usage: fm1_rec NAME OUT.wav\n".data(using: .utf8)!); exit(2) }
var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size: UInt32 = 0
AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
var ids = [AudioObjectID](repeating: 0, count: Int(size) / 4)
AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
var found: [AudioObjectID] = []
for id in ids {
    var na = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var ns = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    AudioObjectGetPropertyData(id, &na, 0, nil, &ns, &name)
    var ia = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var isz: UInt32 = 0
    AudioObjectGetPropertyDataSize(id, &ia, 0, nil, &isz)
    if (name?.takeRetainedValue() as String?) == args[1] && isz > 0 { found.append(id) }
}
guard found.count == 1 else { print(found.isEmpty ? "error no input named \(args[1])" : "error \(found.count) inputs named \(args[1])"); exit(1) }
let engine = AVAudioEngine()
let input = engine.inputNode
var dev = found[0]
let st = AudioUnitSetProperty(input.audioUnit!, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioObjectID>.size))
guard st == noErr else { print("error device not set (\(st))"); exit(1) }
let fmt = input.inputFormat(forBus: 0)
var file: AVAudioFile? = try AVAudioFile(forWriting: URL(fileURLWithPath: args[2]), settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate,
    AVNumberOfChannelsKey: fmt.channelCount, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false])
var frames: AVAudioFramePosition = 0
let lock = NSLock()
input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buf, _ in
    lock.lock()
    try? file?.write(from: buf)
    if frames == 0 { print("rec \(Int(fmt.sampleRate)) \(fmt.channelCount)"); fflush(stdout) }
    frames += AVAudioFramePosition(buf.frameLength)
    lock.unlock()
}
try engine.start()
let t0 = Date()
_ = readLine()
engine.stop()
input.removeTap(onBus: 0)
lock.lock()
file = nil   // (closes the WAV: its header gets the sizes)
print(String(format: "frames %lld seconds %.3f", frames, Date().timeIntervalSince(t0)))
lock.unlock()
