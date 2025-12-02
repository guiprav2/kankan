export default class CardViewDialog {
  constructor(props = {}) {
    this.props = props;
  }
  close(value = 'close') {
    let dialog = this.root?.parentElement;
    if (!dialog) return;
    dialog.close(value);
  }
  requestEdit = () => {
    let dialog = this.root?.parentElement;
    if (dialog) dialog.returnDetail = { columnId: this.props.columnId, cardId: this.props.card?.id };
    this.close('edit');
  };
  requestDelete = () => {
    let dialog = this.root?.parentElement;
    if (dialog) dialog.returnDetail = { columnId: this.props.columnId, cardId: this.props.card?.id };
    this.close('delete');
  };
  formatDate(value) {
    if (!value) return '';
    let date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString?.() ? date.toLocaleString() : date.toString();
  }
}
