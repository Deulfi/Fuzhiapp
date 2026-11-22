# JieLi AC6925A – Amp Board Notes

Facts about the Bluetooth audio chip on the Wuzhi ZK-502MT amp board, collected for anyone working on this board or chip.

> Status: work in progress. Anything marked *unverified* has not been measured on the board yet.

---

## 1. Chip identification

**Marking:** `JL AS24BP0Q237-25A4` → **JieLi AC6925A with 4 Mbit (512 KB) flash**

JieLi markings have a serial number (before the dash) and a part number (after the dash). The part number is what identifies the chip.

| Field   | Value     | Meaning                                       |
|---------|-----------|-----------------------------------------------|
| Prefix  | `AS`      | Prefix letters (AB/AC/AD/AS), no meaning for the ID |
| Year    | `24`      | Made in 2024                                  |
| Lot     | `BP0Q237` | Lot number                                    |
| Series  | `25`      | AC69**25**                                    |
| Variant | `A`       | AC6925**A**                                   |
| Flash   | `4`       | 4 Mbit of built-in flash                      |

**Evidence**
- kagaimiq's chip-marks table: the chips ending in `-25A4` (`AC19AP1S079-25A4`, `AC20BP09548-25A4`) are both AC6925A.
- Other chips with the `AS` prefix follow the same pattern, e.g. `AS20BP03306-25C4` = AC6925C and `AS21BP0B847-65A4` = AC6965A.
- The package matches: the AC6925A comes only in QSOP24 (24 pins on two sides).
- No page lists this exact marking. The ID rests on the marking pattern plus the matching package.
- Note: an AC6925**B** also exists in QSOP24. The AC6925A has 11 GPIOs, the AC6925B has 12.

**Release:** the earliest datasheet found (V1.0) is dated 2018-04-20. The chip on this board was made in 2024.

## 2. Chip overview

- AC692x family (the "BR17" chips) from Zhuhai JieLi Technology
- 32-bit RISC CPU at up to 160 MHz with DSP instructions
- Bluetooth 5.0 (BR/EDR/BLE)
- Stereo DAC, FM radio input, full-speed USB, 11 GPIOs
- VBAT 2.2–5.5 V, VDDIO 2.2–3.6 V (3.3 V logic)
- Operating temperature: −20 to +70 °C
- Clock: 24 MHz crystal (Y1 on this board)

## 3. Pinout (QSOP24)

| Pin | Name    | Function                                              |
|-----|---------|-------------------------------------------------------|
| 1   | PC5     | GPIO (alternate functions: SD1 clock, SPI1, UART2, I²C) |
| 2   | PC4     | GPIO (alternate functions: SD1 command, SPI1, UART2)  |
| 3   | PC3     | GPIO                                                  |
| 4   | USBDM   | USB D−, also used for firmware download               |
| 5   | USBDP   | USB D+, also used for firmware download               |
| 6   | PA0/PA4 | GPIO (two internal pins on one leg)                   |
| 7   | DACR    | Right audio output                                    |
| 8   | DACL    | Left audio output                                     |
| 9   | DACVDD  | Power for the audio section                           |
| 10  | VCOM    | Audio reference voltage (capacitor only)              |
| 11  | DACVSS  | Audio ground                                          |
| 12  | VDDIO   | 3.3 V power for the pins                              |
| 13  | PB5     | GPIO                                                  |
| 14  | PB4     | GPIO                                                  |
| 15  | PB3     | GPIO                                                  |
| 16  | PB1     | GPIO                                                  |
| 17  | PB0     | GPIO                                                  |
| 18  | VBAT    | Main power input (2.2–5.5 V)                          |
| 19  | BT_AVDD | Bluetooth power (decoupling capacitor only)           |
| 20  | BT_RF   | Antenna                                               |
| 21  | FMIP    | FM antenna input                                      |
| 22  | VSSIO   | Ground                                                |
| 23  | BT_OSCI | Crystal in                                            |
| 24  | BT_OSCO | Crystal out                                           |

## 4. Board findings

### Chip orientation
The dot marking pin 1 is at the bottom-right when the chip text reads bottom-to-top.
- **Right row:** pins 1 → 12, bottom to top
- **Left row:** pins 13 → 24, top to bottom

The board layout confirms this: pins 23/24 sit next to the crystal Y1, and pin 20 faces the antenna circuit (L5, C46, C43).

### Traced connections (top side, from photos)

| Pin | Name    | Connected to                  |
|-----|---------|-------------------------------|
| 7   | DACR    | C11 (right audio output cap)  |
| 8   | DACL    | C10 (left audio output cap)   |
| 9   | DACVDD  | Capacitor (right one of the pair next to C24) |
| 10  | VCOM    | Capacitor (left one of the pair next to C24)  |
| 11  | DACVSS  | Short trace (audio ground)    |
| 12  | VDDIO   | C25                           |
| 14  | PB4     | Via to the back side          |
| 15  | PB3     | Via to the back side          |
| 18  | VBAT    | C43                           |
| 19  | BT_AVDD | Capacitor on the left         |
| 20  | BT_RF   | L5 → ANT (PCB zigzag antenna) |
| 22  | VSSIO   | Via (ground)                  |
| 24  | BT_OSCO | Probably crystal Y1 (*unverified*) |

**No visible top-side trace:** pins 1–6, 13, 16, 17, 21, 23. These probably go through vias to the back side.

### USB pads
There is an unpopulated 4-pad footprint above the chip labelled `− D− D+ +`.
- D− → pin 4, D+ → pin 5 (*unverified*)
- With a USB socket soldered to these pads, the stock firmware does not detect a USB stick: nothing changes in what the amp reports over Bluetooth, and switching to the Music source falls straight back to AUX.
- Plugging a stick in while the amp runs sometimes crashes it; the Bluetooth link drops a few seconds later. Booting with the stick already in works.

## 5. USB / firmware download mode

> *Unconfirmed:* taken from kagaimiq's documentation of JieLi chips, not tested on this board.

Pins 4/5 are the chip's USB lines and also its firmware download interface. The chip's built-in boot ROM has a USB bootloader. It starts when booting from flash fails, or when it receives a special signal called **USB_KEY**:

- The key is the 16-bit value `0x16EF`, sent MSB-first
- **D+ = clock, D− = data**; the chip reads data on the rising edge of D+
- Clock around **50 kHz**, no faster (the chip reads the key in software)
- Repeat the key until the chip answers by pulling **both lines low for ~1–2 ms**
- Then stop sending and hand the bus over to the PC

**Notes from the same source**
- The chip turns on ~15 kΩ pulldowns once it receives the key, so the lines need external pullups of 4.7 kΩ or lower; a weak built-in pullup can read as a false answer.
- Right after entering download mode, the chip sets its clock from the 1 ms USB timing pulses on the bus. Other Full- or Low-speed devices on the same hub can disturb that, and the chip then resets into its normal firmware. A separate USB 2.0 hub or a free host port avoids this.
- Other entry methods exist: a UART_KEY signal over the serial pins, and the ISP method.

Not documented yet: the protocol used after entry and PC tools for reading or writing the flash.

## Sources

- [kagaimiq – JieLi chip markings](https://kagaimiq.github.io/jielie/chips/chip-marks.html)
- [kagaimiq – USB_KEY](https://kagaimiq.github.io/jielie/isp/usb/usb-key.html)
- [kagaimiq – JieLi ISP overview](https://kagaimiq.github.io/jielie/isp/)
- [AC6925A datasheet V1.0 (yunthinker mirror)](https://www.yunthinker.com/static/upload/file/20250102/1735803449525164.pdf)
- [JLCPCB – AC6925A (QSOP-24)](https://jlcpcb.com/partdetail/JLCPCBAssembly-AC6925A/C2844256)
