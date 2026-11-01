import Foundation
import CoreWLAN

// Read-only: no scans, association attempts, permission changes or radio changes.
let client = CWWiFiClient.shared()
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let null = NSNull()

func sample() -> [String: Any] {
    var value: [String: Any] = [
        "timestamp": formatter.string(from: Date()), "source": "corewlan",
        "status": "unavailable", "interface": null, "ssid": null, "bssid": null,
        "rssi": null, "noise": null, "snr": null, "txRate": null,
        "channel": null, "band": null, "message": null
    ]
    guard let interface = client.interface() else {
        value["message"] = "No Wi-Fi interface is available on this Mac."
        return value
    }
    value["interface"] = interface.interfaceName ?? "Wi-Fi"
    guard interface.powerOn() else {
        value["status"] = "wifi_off"
        value["message"] = "Wi-Fi is turned off. Turn it on and connect to the network you want to survey."
        return value
    }

    let rssi = interface.rssiValue()
    guard (-127 ... -1).contains(rssi) else {
        value["status"] = interface.interfaceMode() == .none ? "disconnected" : "error"
        value["message"] = interface.interfaceMode() == .none
            ? "Wi-Fi is not connected. Reconnect to continue measuring."
            : "macOS did not return a valid signal reading. No signal value has been invented."
        return value
    }
    value["status"] = "connected"
    value["rssi"] = rssi
    let noise = interface.noiseMeasurement()
    if (-127 ... -1).contains(noise) {
        value["noise"] = noise
        value["snr"] = rssi - noise
    }
    let rate = interface.transmitRate()
    if rate.isFinite && rate > 0 { value["txRate"] = rate }
    if let channel = interface.wlanChannel() {
        value["channel"] = channel.channelNumber
        switch channel.channelBand.rawValue {
        case 1: value["band"] = "2.4 GHz"
        case 2: value["band"] = "5 GHz"
        case 3: value["band"] = "6 GHz"
        default: break
        }
    }
    value["ssid"] = interface.ssid() ?? (null as Any)
    value["bssid"] = interface.bssid() ?? (null as Any)
    if value["ssid"] is NSNull {
        value["message"] = "macOS is hiding the network name. Signal measurements still work. Network names may require Location Services permission for the launching app."
    }
    // Timestamp after the OS queries finish, not when a cached result is sent.
    value["timestamp"] = formatter.string(from: Date())
    return value
}

repeat {
    autoreleasepool {
        let value = sample()
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
    if CommandLine.arguments.contains("--once") { break }
    Thread.sleep(forTimeInterval: 1)
} while true
