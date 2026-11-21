# Install: ESPHome Device Builder

For people who already run the ESPHome Device Builder: the Home Assistant add-on ("ESPHome Device Builder"), the Docker image, or an LXC/VM. You get a normal ESPHome config that you can change, and updates go over Wi-Fi.

The Device Builder fetches the component from this branch on GitHub. No files need to be copied to the machine it runs on.

## 1. Secrets

In the Device Builder, open Secrets (top right) and add:

```yaml
wifi_ssid: "your-wifi"
wifi_password: "your-wifi-password"
api_key: "..."
```

`api_key` encrypts the connection to Home Assistant, and OTA updates use it too. It is 32 random bytes in base64. Ways to get one:

- When you create a device with the Device Builder's wizard, it writes a random key into the new YAML (`api: encryption: key:`). Copy that.
- The ESPHome docs page of the Native API component shows a freshly generated key on every load.
- PowerShell:

  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
  ```

- Linux/macOS:

  ```sh
  openssl rand -base64 32
  ```

## 2. The config

Create a new device (skip the wizard if offered, or let it finish and replace everything), and paste the content of [`wuzhi-amp.yaml`](../wuzhi-amp.yaml). Then replace the `external_components` block with the GitHub source:

```yaml
external_components:
  - source:
      type: git
      url: https://github.com/Deulfi/Fuzhiapp
      ref: esphome-bridge
      path: components
    components: [wuzhi_amp]
    refresh: 1d
```

`refresh` is how often the Device Builder checks GitHub for a newer component. `0s` fetches on every build (useful while testing new versions), `1d` once a day.

Remove entities you don't want; all of them are optional. [configuration.md](configuration.md) explains each one.

Click Validate. "Configuration valid" means the YAML is fine.

## 3. First flash

A Device Builder on another machine can't reach the board's USB port, and browsers only allow USB flashing on HTTPS pages. So the first flash goes through a file:

1. Install, then Manual download, then "Factory format". The first build takes several minutes (it downloads the ESP32 toolchain once).
2. Plug the board into your PC, open https://web.esphome.io in Chrome or Edge, click Connect, pick the board's port, then Install and select the downloaded file.
   If no port shows up: unplug, hold BOOT, plug in, release BOOT, try again.

If your Device Builder runs on the same PC, or is reached over HTTPS, Install, then "Plug into this computer" does the same in one step.

## 4. The amp

Close the PWA and the vendor app. Open Logs for the device in the Device Builder. Within a few seconds you should see:

```
[I][wuzhi_amp]: Found amp "wuzhi APP", RSSI -63; stored (address not logged)
[I][wuzhi_amp]: Connected to amp, discovering services
[I][wuzhi_amp]: Authenticated with amp
[I][wuzhi_amp]: Target info: proto 2.1; vol 20/30; ...
```

If not, see [troubleshooting.md](troubleshooting.md).

## 5. Home Assistant

Settings, Devices and services: Home Assistant shows the discovered "Wuzhi Amp Bridge". Click Configure and paste the `api_key` from your Secrets.

## Updates

Install, then Wirelessly. With `refresh: 1d`, a new component version from GitHub is picked up at most a day after it is published; Clean build files forces it at once.

## Pinning a component version

To stay on a released version instead of the newest commit, use the release tag as `ref`:

```yaml
      ref: esphome-v0.1.0
```
