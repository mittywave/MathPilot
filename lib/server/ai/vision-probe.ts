/** Synthetic materials only; no student input or answer leaks in instructions.
 * Four independent colors reduce blind guessing. This is a capability probe,
 * not a claim that the model passed real question recognition quality checks.
 */
const images = {
    red: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYklEQVR4nO3PMQ0AIADAMMAF/m0hBhEcDcmqYJtn7/GzpQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaBdJhgBjmm+CXIAAAAASUVORK5CYII=',
    green: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQEADSjCOxYngcVnSU9DOfc/4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfW7eAXUF08eJAAAAAElFTkSuQmCC',
    blue: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZUlEQVR4nO3PQQ3AIADAQEADmvCvAh0TweOypKegnfvc8WdLB7xqQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQPsAkSYBwMs9TDkAAAAASUVORK5CYII=',
    yellow: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZElEQVR4nO3PQQ3AIADAQEAI/kVhg/9E8Lgs6Slo5z17/NnSAa8a0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0D6PIAJvdxdhhAAAAABJRU5ErkJggg==',
    purple: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQMAKijGEtongcVnSU9DOs+/4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgff5uAfLYv8+zAAAAAElFTkSuQmCC',
    orange: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQEADdjHOayJ4XJb0FLTznj3+bOmAVw1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oH7XaAguTPyv4AAAAAElFTkSuQmCC',
};
export function visionChallenge(random = crypto.getRandomValues(new Uint32Array(4))) {
    const names = Object.keys(images) as (keyof typeof images)[];
    const expected = Array.from(random, n => names[n % names.length]);
    return {
        images: expected.map(name => images[name]),
        prompt: 'Identify the dominant color of each attached image, in attachment order. Return a colors array of four English color names.',
        schema: { type: 'object', properties: { colors: { type: 'array', items: { type: 'string', enum: names }, minItems: 4, maxItems: 4 } }, required: ['colors'], additionalProperties: false },
        validateOutput: (value: unknown) => JSON.stringify((value as {colors?:unknown})?.colors) === JSON.stringify(expected),
    };
}
