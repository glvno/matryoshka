// SPDX-License-Identifier: GPL-3.0-only
// fm1_rec INPUT OUT.wav: record a CoreAudio input device with AVAudioEngine at the device's own rate into a 16-bit WAV,
// until a line arrives on stdin (or stdin closes). INPUT is the device's name (the FM-1's USB audio: "Matryoshka"), or
// usb-location:HEX, resolved through IOKit to its physical serial when present (#698, #733). It prints "rec RATE CHANNELS"
// once the first buffer came, and at the end "frames N seconds S". web/scripts/audio-capture.mjs builds and runs it for the
// device check's scenarios: ffmpeg's avfoundation input delivered about a third of the FM-1's buffers (9.2 s of a 30 s
// capture on 2026-11-06), where this records them all (44049 frames a second over 30 s).
import AVFoundation
import CoreAudio
import IOKit

/// CoreAudio uses the physical USB serial when present, otherwise location.
/// Resolve location through IOKit first: a 32-digit serial is never a location.
func usbIdentity(ofUID uid: String) -> String? {
    let fields = uid.split(separator: ":", omittingEmptySubsequences: false)
    guard fields.count >= 5, fields[0] == "AppleUSBAudioEngine" else { return nil }
    return String(fields[fields.count - 2])
}
func usbMatches(uid: String, location: UInt32, serial: String?) -> Bool {
    guard let identity = usbIdentity(ofUID: uid) else { return false }
    if let serial = serial, !serial.isEmpty { return identity == serial }
    return UInt32(identity, radix: 16) == location
}
func usbAtLocation(_ location: UInt32) -> (found: Bool, serial: String?) {
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostDevice"), &iterator) == KERN_SUCCESS else { return (false, nil) }
    defer { IOObjectRelease(iterator) }
    var matches = 0
    var serial: String?
    while true {
        let device = IOIteratorNext(iterator)
        if device == 0 { break }
        defer { IOObjectRelease(device) }
        let loc = IORegistryEntryCreateCFProperty(device, "locationID" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber
        if loc?.uint32Value == location {
            matches += 1
            serial = IORegistryEntryCreateCFProperty(device, "USB Serial Number" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String
        }
    }
    return (matches == 1, serial)
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "--test-identity" {
    let prefix = "AppleUSBAudioEngine:brighght studio:Matryoshka STAGE:"
    assert(usbMatches(uid: prefix + "1130000:1,2", location: 0x01130000, serial: nil))
    assert(usbMatches(uid: prefix + "00112233445566778899AABBCCDDEEFF:1,2", location: 0x01130000, serial: "00112233445566778899AABBCCDDEEFF"))
    assert(!usbMatches(uid: prefix + "00112233445566778899AABBCCDDEEFF:1,2", location: 0x01130000, serial: nil))
    assert(!usbMatches(uid: prefix + "1130000:1,2", location: 0x01130000, serial: "another-unit"))
    assert(!usbMatches(uid: prefix + "2130000:1,2", location: 0x01130000, serial: nil))
    print("USB audio identity: location, serial and ambiguity checks passed")
    exit(0)
}
guard args.count == 3 else { FileHandle.standardError.write("usage: fm1_rec NAME|usb-location:HEX OUT.wav\n".data(using: .utf8)!); exit(2) }
let byLocation = args[1].hasPrefix("usb-location:")
let location = byLocation ? UInt32(args[1].dropFirst(13).lowercased().replacingOccurrences(of: "0x", with: ""), radix: 16) : nil
if byLocation && location == nil { print("error invalid USB location"); exit(2) }
let physical = location.map { usbAtLocation($0) }
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
    let devName = name?.takeRetainedValue() as String?
    guard isz > 0 else { continue }
    if let want = location {
        var ua = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var uid: Unmanaged<CFString>?
        var us = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        AudioObjectGetPropertyData(id, &ua, 0, nil, &us, &uid)
        if let u = uid?.takeRetainedValue() as String?, physical?.found == true && usbMatches(uid: u, location: want, serial: physical?.serial) { found.append(id) }
    } else if devName == args[1] { found.append(id) }
}
let what = location.map { "at USB location \(String($0, radix: 16))" } ?? "named \(args[1])"
guard found.count == 1 else { print(found.isEmpty ? "error no input \(what)" : "error \(found.count) inputs \(what)"); exit(1) }
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
