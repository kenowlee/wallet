import { useSettingsStore } from '../stores/Settings';
import { CryptoCurrency } from './Constants';

export function twoDigit(value: number) {
    if (value < 10) return `0${value}`;
    return value.toString();
}

export function calculateDisplayedDecimals(amount: number | null, currency: CryptoCurrency) {
    if (amount === null) return 0;

    const { decimals, btcDecimals, btcUnit } = useSettingsStore();

    if (currency === CryptoCurrency.BTC) {
        const maxDecimals = Math.min(btcDecimals.value, btcUnit.value.decimals);
        if (amount === 0) return maxDecimals;

        if (btcUnit.value.ticker === 'mBTC') {
            // For mBTC, make sure that 2 significant digits are always displayed
            if (amount < 0.001 * 1e5) return 5;
            if (amount < 0.01 * 1e5) return Math.max(maxDecimals, 4);
            if (amount < 0.1 * 1e5) return Math.max(maxDecimals, 3);
            if (amount < 1 * 1e5) return Math.max(maxDecimals, 2);
            if (amount < 10 * 1e5) return Math.max(maxDecimals, 1);
        } else {
            // For BTC, make sure that 3 significant digits are always displayed
            if (amount < 0.00001 * 1e8) return 8;
            if (amount < 0.0001 * 1e8) return Math.max(maxDecimals, 7);
            if (amount < 0.001 * 1e8) return Math.max(maxDecimals, 6);
            if (amount < 0.01 * 1e8) return Math.max(maxDecimals, 5);
            if (amount < 0.1 * 1e8) return Math.max(maxDecimals, 4);
            if (amount < 1 * 1e8) return Math.max(maxDecimals, 3);
            if (amount < 10 * 1e8) return Math.max(maxDecimals, 2);
            if (amount < 100 * 1e8) return Math.max(maxDecimals, 1);
        }
        return maxDecimals;
    }

    // For NIM, make sure that 2 significant digits are always displayed
    if (amount === 0) return decimals.value;
    if (amount < 0.001 * 1e5) return 5;
    if (amount < 0.01 * 1e5) return Math.max(decimals.value, 4);
    if (amount < 0.1 * 1e5) return Math.max(decimals.value, 3);
    if (amount < 1 * 1e5) return Math.max(decimals.value, 2);
    if (amount < 10 * 1e5) return Math.max(decimals.value, 1);
    return decimals.value;
}

export function numberToLiteral(n: number): String {
    //https://stackoverflow.com/questions/5529934/javascript-numbers-to-words
    var ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    var tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
    var teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
    
    function convert_millions(num: number): String {
      if (num >= 1000000) {
        return convert_millions(Math.floor(num / 1000000)) + " million " + convert_thousands(num % 1000000);
      } else {
        return convert_thousands(num);
      }
    }
    
    function convert_thousands(num: number): String {
      if (num >= 1000) {
        return convert_hundreds(Math.floor(num / 1000)) + " thousand " + convert_hundreds(num % 1000);
      } else {
        return convert_hundreds(num);
      }
    }
    
    function convert_hundreds(num: number): String {
      if (num > 99) {
        return ones[Math.floor(num / 100)] + " hundred " + convert_tens(num % 100);
      } else {
        return convert_tens(num);
      }
    }
    
    function convert_tens(num: number): String {
        if (num < 10) return ones[num];
        else if (num >= 10 && num < 20) return teens[num - 10];
        else {
            return tens[Math.floor(num / 10)] + " " + ones[num % 10];
        }
    }
    
    if (n == 0)
        return "zero";
    return convert_millions(n);
}

export function numberToLiteralTimes(n: number): String {
    const timesTable = ["", "once", "twice", "thrice"];
    n = parseInt(n.toString());
    if (n <= 0)
        throw new Error("Invalid Input! Times number must be positive >= 1!");
    if (n < timesTable.length)
        return timesTable[n];
    return numberToLiteral(n) + " times";
}
