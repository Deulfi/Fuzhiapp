"""Tiny reference frame builder for the Jieli RCSP transport (facts from the spec). Used to generate spec examples."""
def frame(opcode, sn, data=b"", response=True, from_host=True):
    flags = (0x80 if from_host else 0) | (0x40 if response else 0)
    params = bytes([sn]) + data            # host->device command: sn + payload
    return b"\xFE\xDC\xBA" + bytes([flags, opcode]) + len(params).to_bytes(2, "big") + params + b"\xEF"

def attr(t, d):            # TLV used in SysInfo: len(=1+len(d)), type, data
    return bytes([len(d) + 1, t]) + d

if __name__ == "__main__":
    ex = {
     "GetTargetInfo(all)":      frame(0x03, 1, bytes.fromhex("ffffffff") + b"\x00"),
     "GetSysInfo public vol":   frame(0x07, 2, b"\xff" + (2).to_bytes(4, "big")),
     "SetSysInfo volume=20":    frame(0x08, 3, b"\xff" + attr(1, bytes([20]))),
     "Function: switch to AUX": frame(0x0E, 4, bytes([0xFF, 3])),
     "Custom DSP: balance L=10 R=10": frame(0xFF, 5, bytes([0xAA, 3, 0x0C, 10, 10, 0x55])),
     "Custom DSP: query":       frame(0xFF, 6, bytes([0xAA, 1, 0x1F, 0x55])),
    }
    for k, v in ex.items():
        print(f"{k:34s} {v.hex(' ')}")
