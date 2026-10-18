// FT8's error protection: a 14-bit CRC on the 77-bit message and the
// (174, 91) LDPC code from WSJT-X, with the generator and parity checks as
// tabulated in ft8_lib (kFTX_LDPC_generator, kFTX_LDPC_Nm).

/**
 * CRC-14 with polynomial 0x2757, as FT8 computes it over the message padded
 * with five zeros.
 */
export function crc14(bits: readonly number[]): number {
  let crc = 0;
  for (const bit of bits) {
    const feedback = ((crc >> 13) & 1) ^ bit;
    crc = (crc << 1) & 0x3fff;

    if (feedback) {
      crc ^= 0x2757;
    }
  }

  return crc;
}

/**
 * Each row, in hex, gives one parity bit as the XOR of the message bits it
 * selects.
 */
const GENERATOR = [
  '8329ce11bf31eaf509f27fc0',
  '761c264e25c2593354931320',
  'dc265902fb277c6410a1bdc0',
  '1b3f417858cd2dd33ec7f620',
  '09fda4fee04195fd034783a0',
  '077cccc11b8873ed5c3d48a0',
  '29b62afe3ca036f4fe1a9da0',
  '6054faf5f35d96d3b0c8c3e0',
  'e20798e4310eed27884ae900',
  '775c9c08e80e26ddae563180',
  'b0b811028c2bf997213487c0',
  '18a0c9231fc60adf5c5ea320',
  '76471e8302a0721e01b12b80',
  'ffbccb80ca8341fafb47b2e0',
  '66a72a158f9325a2bf671700',
  'c4243689fe85b1c51363a180',
  '0dff739414d1a1b34b1c2700',
  '15b48830636c8b99894972e0',
  '29a89c0d3de81d665489b0e0',
  '4f126f37fa51cbe61bd6b940',
  '99c47239d0d97d3c84e09400',
  '1919b75119765621bb4f1e80',
  '09db12d731faee0b86df6b80',
  '488fc33df43fbdeea4eafb40',
  '827423ee40b675f756eb5fe0',
  'abe197c484cb74757144a9a0',
  '2b500e4bc0ec5a6d2bdbdd00',
  'c474aa53d702187616693600',
  '8eba1a13db3390bd6718cec0',
  '753844673a27782cc42012e0',
  '06ff83a145c37035a5c12680',
  '3b37417858cc2dd33ec3f620',
  '9a4a5a28ee17ca9c324842c0',
  'bc29f465309c977e89610a40',
  '2663ae6ddf8b5ce2bb294880',
  '46f231efe457034c18144180',
  '3fb2ce85abe9b0c72e06fbe0',
  'de87481f282c153971a0a2e0',
  'fcd7ccf23c69fa99bba14120',
  'f0261447e9490ca8e474cec0',
  '4410115818196f95cdd70120',
  '088fc31df4bfbde2a4eafb40',
  'b8fef1b6307729fb0a078c00',
  '5afea7acccb77bbc9d99a900',
  '49a7016ac653f65ecdc90760',
  '1944d085be4e7da8d6cc7d00',
  '251f62adc4032f0ee7140020',
  '56471f8702a0721e00b12b80',
  '2b8e4923f2dd51e2d537fa00',
  '6b550a40a66f4755de95c260',
  'a18ad28d4e27fe92a4f6c840',
  '10c2e586388cb82a3d807580',
  'ef34a41817ee02133db2eb00',
  '7e9c0c54325a9c15836e0000',
  '3693e572d1fde4cdf079e860',
  'bfb2cec5abe1b0c72e07fbe0',
  '7ee18230c583cccc57d4b080',
  'a066cb2fedafc9f526641260',
  'bb23725abc47cc5f4cc4cd20',
  'ded9dba3bee40c59b5609b40',
  'd9a7016ac653e6decdc90360',
  '9ad46aed5f707f280ab5fc40',
  'e5921c77822587316d7d3c20',
  '4f14da8242a8b86dca733520',
  '8b8b507ad467d4441df770e0',
  '22831c9cf1169467ad04b680',
  '213b838fe2ae54c38ee71800',
  '5d926b6dd71f085181a4e120',
  '66ab79d4b29ee6e69509e560',
  '958148682d748a38dd68baa0',
  'b8ce020cf069c32a723ab140',
  'f4331d6d461607e957527460',
  '6da23ba424b9596133cf9c80',
  'a636bcbc7b30c5fbeae67fe0',
  '5cb0d86a07df654a9089a200',
  'f11f106848780fc9ecdd80a0',
  '1fbb5364fb8d2c9d730d5ba0',
  'fcb86bc70a50c9d02a5d0340',
  'a534433029eac15f322e34c0',
  'c989d9c7c3d3b8c55d751300',
  '7bb38b2f0186d46643ae9620',
  '2644ebadeb44b9467d1f42c0',
  '608cc857594bfbb55d696000',
];

/** For each of the 83 parity checks, the (1-based) codeword bits it covers. */
const CHECKS = [
  [4, 31, 59, 91, 92, 96, 153],
  [5, 32, 60, 93, 115, 146],
  [6, 24, 61, 94, 122, 151],
  [7, 33, 62, 95, 96, 143],
  [8, 25, 63, 83, 93, 96, 148],
  [6, 32, 64, 97, 126, 138],
  [5, 34, 65, 78, 98, 107, 154],
  [9, 35, 66, 99, 139, 146],
  [10, 36, 67, 100, 107, 126],
  [11, 37, 67, 87, 101, 139, 158],
  [12, 38, 68, 102, 105, 155],
  [13, 39, 69, 103, 149, 162],
  [8, 40, 70, 82, 104, 114, 145],
  [14, 41, 71, 88, 102, 123, 156],
  [15, 42, 59, 106, 123, 159],
  [1, 33, 72, 106, 107, 157],
  [16, 43, 73, 108, 141, 160],
  [17, 37, 74, 81, 109, 131, 154],
  [11, 44, 75, 110, 121, 166],
  [45, 55, 64, 111, 130, 161, 173],
  [8, 46, 71, 112, 119, 166],
  [18, 36, 76, 89, 113, 114, 143],
  [19, 38, 77, 104, 116, 163],
  [20, 47, 70, 92, 138, 165],
  [2, 48, 74, 113, 128, 160],
  [21, 45, 78, 83, 117, 121, 151],
  [22, 47, 58, 118, 127, 164],
  [16, 39, 62, 112, 134, 158],
  [23, 43, 79, 120, 131, 145],
  [19, 35, 59, 73, 110, 125, 161],
  [20, 36, 63, 94, 136, 161],
  [14, 31, 79, 98, 132, 164],
  [3, 44, 80, 124, 127, 169],
  [19, 46, 81, 117, 135, 167],
  [7, 49, 58, 90, 100, 105, 168],
  [12, 50, 61, 118, 119, 144],
  [13, 51, 64, 114, 118, 157],
  [24, 52, 76, 129, 148, 149],
  [25, 53, 69, 90, 101, 130, 156],
  [20, 46, 65, 80, 120, 140, 170],
  [21, 54, 77, 100, 140, 171],
  [35, 82, 133, 142, 171, 174],
  [14, 30, 83, 113, 125, 170],
  [4, 29, 68, 120, 134, 173],
  [1, 4, 52, 57, 86, 136, 152],
  [26, 51, 56, 91, 122, 137, 168],
  [52, 84, 110, 115, 145, 168],
  [7, 50, 81, 99, 132, 173],
  [23, 55, 67, 95, 172, 174],
  [26, 41, 77, 109, 141, 148],
  [2, 27, 41, 61, 62, 115, 133],
  [27, 40, 56, 124, 125, 126],
  [18, 49, 55, 124, 141, 167],
  [6, 33, 85, 108, 116, 156],
  [28, 48, 70, 85, 105, 129, 158],
  [9, 54, 63, 131, 147, 155],
  [22, 53, 68, 109, 121, 174],
  [3, 13, 48, 78, 95, 123],
  [31, 69, 133, 150, 155, 169],
  [12, 43, 66, 89, 97, 135, 159],
  [5, 39, 75, 102, 136, 167],
  [2, 54, 86, 101, 135, 164],
  [15, 56, 87, 108, 119, 171],
  [10, 44, 82, 91, 111, 144, 149],
  [23, 34, 71, 94, 127, 153],
  [11, 49, 88, 92, 142, 157],
  [29, 34, 87, 97, 147, 162],
  [30, 50, 60, 86, 137, 142, 162],
  [10, 53, 66, 84, 112, 128, 165],
  [22, 57, 85, 93, 140, 159],
  [28, 32, 72, 103, 132, 166],
  [28, 29, 84, 88, 117, 143, 150],
  [1, 26, 45, 80, 128, 147],
  [17, 27, 89, 103, 116, 153],
  [51, 57, 98, 163, 165, 172],
  [21, 37, 73, 138, 152, 169],
  [16, 47, 76, 130, 137, 154],
  [3, 24, 30, 72, 104, 139],
  [9, 40, 90, 106, 134, 151],
  [15, 58, 60, 74, 111, 150, 163],
  [18, 42, 79, 144, 146, 152],
  [25, 38, 65, 99, 122, 160],
  [17, 42, 75, 129, 170, 172],
].map((check) => check.map((bit) => bit - 1));

const MESSAGE_BITS = 91;
const CODEWORD_BITS = 174;

const generator = GENERATOR.map((hex) => {
  const bits: number[] = [];
  for (const digit of hex) {
    const value = Number.parseInt(digit, 16);
    bits.push((value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1);
  }

  return bits.slice(0, MESSAGE_BITS);
});

/** The codeword: the 91 message bits followed by 83 parity bits. */
export function ldpcEncode(message: readonly number[]): number[] {
  const parity = generator.map((row) => {
    let sum = 0;
    for (let j = 0; j < MESSAGE_BITS; j++) {
      sum ^= row[j] & message[j];
    }

    return sum;
  });
  return [...message, ...parity];
}

export type LdpcResult = {
  readonly bits: readonly number[];
  /** Whether every parity check passed. */
  readonly ok: boolean;
  readonly iterations: number;
};

/**
 * Normalized min-sum belief propagation. `llr` holds a log-likelihood ratio
 * per codeword bit, positive for 0.
 */
export function ldpcDecode(
  llr: readonly number[],
  maxIterations = 80,
): LdpcResult {
  const messages = CHECKS.map((check) => new Float64Array(check.length));
  const total = new Float64Array(CODEWORD_BITS);
  const hard = new Uint8Array(CODEWORD_BITS);
  let iteration = 0;
  let ok = false;
  for (; iteration < maxIterations; iteration++) {
    total.set(llr);
    CHECKS.forEach((check, m) => {
      check.forEach((bit, i) => (total[bit] += messages[m]![i]!));
    });

    for (let v = 0; v < CODEWORD_BITS; v++) {
      hard[v] = total[v]! < 0 ? 1 : 0;
    }

    ok = CHECKS.every(
      (check) => check.reduce((sum, bit) => sum ^ hard[bit]!, 0) === 0,
    );

    if (ok) {
      break;
    }

    CHECKS.forEach((check, m) => {
      const incoming = check.map((bit, i) => total[bit]! - messages[m]![i]!);
      let sign = 1;
      let smallest = Infinity;
      let second = Infinity;
      let at = -1;
      incoming.forEach((value, i) => {
        const size = Math.abs(value);
        if (value < 0) {
          sign = -sign;
        }

        if (size < smallest) {
          second = smallest;
          smallest = size;
          at = i;
        } else if (size < second) {
          second = size;
        }
      });
      incoming.forEach((value, i) => {
        messages[m]![i] =
          sign * (value < 0 ? -1 : 1) * (i === at ? second : smallest) * 0.8;
      });
    });
  }

  return { bits: Array.from(hard), ok, iterations: iteration };
}
