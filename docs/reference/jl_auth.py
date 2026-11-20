"""Jieli RCSP link authentication = Bluetooth legacy auth E1 (SAFER+), 16-byte output.
Reference implementation written from the public Bluetooth Core spec (Vol 2, Part H);
checked against vectors produced by running the vendor's native auth routine."""

EXP = [pow(45, i, 257) % 256 for i in range(256)]
LOG = [0] * 256
for _i, _v in enumerate(EXP):
    LOG[_v] = _i

XOR_POS = (0, 3, 4, 7, 8, 11, 12, 15)          # positions that are XORed first / added second
SHUFFLE = (8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3)  # "Armenian shuffle"

def _rotl8(b, n):
    return ((b << n) | (b >> (8 - n))) & 0xFF

def key_schedule(key):
    k = list(key) + [0]
    k[16] = 0
    for b in key:
        k[16] ^= b
    subkeys = [list(key)]
    for p in range(2, 18):
        k = [_rotl8(b, 3) for b in k]
        sk = []
        for i in range(16):
            bias = EXP[EXP[(17 * p + i + 1) & 0xFF]]
            sk.append((k[(p - 1 + i) % 17] + bias) & 0xFF)
        subkeys.append(sk)
    return subkeys

def _key_mix_1(x, k):   # first mix: xor at XOR_POS, add elsewhere
    return [(x[i] ^ k[i]) if i in XOR_POS else (x[i] + k[i]) & 0xFF for i in range(16)]

def _key_mix_2(x, k):   # second mix: add at XOR_POS, xor elsewhere
    return [(x[i] + k[i]) & 0xFF if i in XOR_POS else (x[i] ^ k[i]) for i in range(16)]

def _pht_layer(x):
    y = list(x)
    for i in range(0, 16, 2):
        a, b = x[i], x[i + 1]
        y[i], y[i + 1] = (2 * a + b) & 0xFF, (a + b) & 0xFF
    return y

def _linear(x):
    for _ in range(3):
        x = _pht_layer(x)
        x = [x[SHUFFLE[i]] for i in range(16)]
    return _pht_layer(x)

def _round(x, k1, k2):
    x = _key_mix_1(x, k1)
    x = [EXP[v] if i in XOR_POS else LOG[v] for i, v in enumerate(x)]
    x = _key_mix_2(x, k2)
    return _linear(x)

def safer_plus(key, data, prime=False):
    sk = key_schedule(key)
    x = list(data)
    orig = list(data)
    for r in range(1, 9):
        if prime and r == 3:                       # Ar': add original input into round-3 input
            x = [(x[i] ^ orig[i]) if i in XOR_POS else (x[i] + orig[i]) & 0xFF for i in range(16)]
        x = _round(x, sk[2 * r - 2], sk[2 * r - 1])
    return bytes(_key_mix_1(x, sk[16]))

def _offset_key(k):
    # layout observed in the vendor binary (matches Core spec K~): i=0..7 alt (+,^), i=8..15 alt (^,+)
    c = (233, 229, 223, 193, 179, 167, 149, 131, 233, 229, 223, 193, 179, 167, 149, 131)
    out = []
    for i in range(16):
        add = (i % 2 == 0) if i < 8 else (i % 2 == 1)
        out.append((k[i] + c[i]) & 0xFF if add else k[i] ^ c[i])
    return bytes(out)

def e1(key, rand, addr6):
    e = (bytes(addr6) * 3)[:16]
    t = safer_plus(key, rand)
    mixed = bytes((e[i] + (t[i] ^ rand[i])) & 0xFF for i in range(16))
    return safer_plus(_offset_key(key), mixed, prime=True)

DEFAULT_KEY = bytes.fromhex("06775f87918dd423005df1d8cf0c142b")
FIXED_ADDR = bytes.fromhex("112233332211")

def auth_response(challenge16, key=DEFAULT_KEY):
    """The 17-byte reply frame: 0x01 followed by E1 output."""
    return b"\x01" + e1(key, challenge16, FIXED_ADDR)

if __name__ == "__main__":
    vec = {
        "00112233445566778899aabbccddeeff": "26a69c072324c5e660c28ff912dcd857",
        "00000000000000000000000000000000": "9e43df377b3a46ce751634667e215de5",
        "0102030405060708090a0b0c0d0e0f10": "655d48686e418cf71f25fbc5cbeffa77",
    }
    for r, exp in vec.items():
        got = e1(DEFAULT_KEY, bytes.fromhex(r), FIXED_ADDR).hex()
        print(r, got, "OK" if got == exp else "MISMATCH (want %s)" % exp)
