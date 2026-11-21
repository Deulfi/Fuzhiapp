# Install: ESPHome command line

Build and flash from your own PC. Works the same on Windows, Linux and macOS; the commands differ only in how Python is started.

## 1. Install ESPHome

You need Python 3.11 or newer.

**Windows (PowerShell):**

```powershell
py -3.12 -m venv $HOME\esphome-venv
```

```powershell
& $HOME\esphome-venv\Scripts\Activate.ps1
```

```powershell
pip install esphome
```

**Linux / macOS:**

```sh
python3 -m venv ~/esphome-venv
```

```sh
source ~/esphome-venv/bin/activate
```

```sh
pip install esphome
```

Check it:

```sh
esphome version
```

Activate the venv again in every new terminal before using `esphome`.

On Linux, flashing over USB needs access to the serial port. If the upload fails with "permission denied", add yourself to the `dialout` group (`sudo usermod -aG dialout $USER`) and log in again.

## 2. Get the files

Clone this branch:

```sh
git clone --branch esphome-bridge https://github.com/Deulfi/Fuzhiapp.git wuzhi-amp-bridge
```

```sh
cd wuzhi-amp-bridge
```

Or download the branch as ZIP from GitHub (switch to `esphome-bridge`, then Code, Download ZIP) and unpack it.

## 3. Secrets

Copy the template:

```powershell
Copy-Item secrets.example.yaml secrets.yaml
```

(Linux/macOS: `cp secrets.example.yaml secrets.yaml`.)

Generate an API key and put it into `secrets.yaml` as `api_key`, together with your Wi-Fi name and password.

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
```

```sh
openssl rand -base64 32
```

`secrets.yaml` is git-ignored. Don't share it.

## 4. Adjust the config (optional)

[`wuzhi-amp.yaml`](../wuzhi-amp.yaml) uses the component from this folder (`type: local`), so local changes to the component are built in. It contains every entity; remove what you don't want. See [configuration.md](configuration.md).

## 5. Build and flash

1. Close the PWA and the vendor app.
2. Plug the board in.
3. Run:

   ```sh
   esphome run wuzhi-amp.yaml
   ```

   The first build downloads the ESP32 toolchain (about 1 GB) and takes several minutes. When asked for the upload port, pick the USB port.
   If no port shows up or the upload fails: unplug, hold BOOT, plug in, release BOOT, run the command again.

After flashing, the log starts. You should see `Found amp`, then `Authenticated with amp` and the target info. Stop it with Ctrl+C.

## 6. Later

- Show the log: `esphome logs wuzhi-amp.yaml`
- Update over Wi-Fi: `esphome run wuzhi-amp.yaml`, then pick the network address instead of the USB port.
- Get the newest component: `git pull` in the folder, then `esphome run` again.

## 7. Home Assistant

Settings, Devices and services: configure the discovered "Wuzhi Amp Bridge" and paste `api_key` from `secrets.yaml`.
