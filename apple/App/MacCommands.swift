#if os(macOS)
import SwiftUI

/// The Mac's menus: the editor's keys (they also work without the menus) where a Mac user looks.
struct SlideCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") { model.undo() }.keyboardShortcut("z", modifiers: .command).disabled(!(model.slide?.canUndo ?? false))
            Button("Redo") { model.redo() }.keyboardShortcut("z", modifiers: [.command, .shift]).disabled(!(model.slide?.canRedo ?? false))
        }
        CommandMenu("Slide") {
            Button("Develop and Next") { model.keep() }.disabled(model.slide == nil)
            Button("Skip") { model.skip(advance: false) }.disabled(model.slide == nil)
            Button("Rotate Right") { model.turn() }.disabled(model.slide == nil)
            Button("Rotate Left") { model.turn(clockwise: false) }.disabled(model.slide == nil)
            Divider()
            Button("Next Slide to Develop") { model.nextUndeveloped() }.keyboardShortcut(.tab, modifiers: .option).disabled(model.tray == nil)
            Button("Fit Curves to Data") { model.fitCurves() }.disabled(model.slide == nil)
        }
        CommandMenu("Tray") {
            Button("Upload Developed Slides") { model.upload(onlyReady: true) }.keyboardShortcut("u", modifiers: [.command, .shift]).disabled(model.tray == nil || model.busy)
            Button("Clean Card") { model.cleanCard() }.disabled(model.tray == nil || model.busy || !model.cleanupBlockers.isEmpty || model.card == nil)
            Divider()
            Button("All Trays") { model.close() }.keyboardShortcut("0", modifiers: .command).disabled(model.tray == nil)
        }
    }
}
#endif
