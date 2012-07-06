/**
 * Created with JetBrains WebStorm.
 * User: Dror
 * Date: 06/07/12
 * Time: 14:49
 * To change this template use File | Settings | File Templates.
 */

var items = [

    {
        "topic": "Spanish",
        "type": "Book",
        "title": "Basic spanish",
        "author": "Paul1"
    },
    {
        "topic": "Spanish",
        "type": "Podcast",
        "title": "Intermediate spanish",
        "author": "dd"
    }
];

exports.getContent = function() {
    return items;
};