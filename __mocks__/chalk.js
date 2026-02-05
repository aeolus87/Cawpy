// Mock chalk to avoid ES module issues in Jest
const chalk = {
    red: (text) => text,
    green: (text) => text,
    yellow: (text) => text,
    blue: (text) => text,
    magenta: (text) => text,
    cyan: (text) => text,
    white: (text) => text,
    gray: (text) => text,
    black: (text) => text,
    bold: (text) => text,
    dim: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    inverse: (text) => text,
    strikethrough: (text) => text,
};

module.exports = chalk;
